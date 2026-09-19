import type { BrainStore } from "./store.js";
import {
  UNTRUSTED_NOTICE,
  type ActiveContextResult,
  type CaptureItem,
  type ContextPackItem,
  type ContextPurpose,
  type GetActiveContextInput,
} from "./types.js";

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function itemText(kind: ContextPackItem["kind"], item: CaptureItem | { text: string }): string {
  if ("body" in item) {
    const title = item.title ? `${item.title}: ` : "";
    return `[${kind}] ${title}${item.body}`;
  }
  return `[${kind}] ${item.text}`;
}

/** Drop captures whose id is referenced as supersedes_id by any peer in the same project. */
export function filterSuperseded(captures: CaptureItem[]): CaptureItem[] {
  const supersededIds = new Set(
    captures
      .map((c) => c.supersedes_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  return captures.filter((c) => !supersededIds.has(c.id));
}

/**
 * Pack order by purpose (always rules → brief first when they fit):
 * - coding: rules, brief, recent decisions, recent notes (decisions preferred)
 * - decision: rules, brief, recent decisions (more), notes sparse
 * - handoff: brief, rules, recent decisions + notes
 * - review: rules, brief, decisions, notes tagged review-ish
 */
function rankCaptures(
  purpose: ContextPurpose,
  decisions: CaptureItem[],
  notes: CaptureItem[],
): CaptureItem[] {
  const dec = [...decisions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const note = [...notes].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  switch (purpose) {
    case "decision":
      return [...dec, ...note.slice(0, 3)];
    case "review": {
      const reviewish = note.filter((n) =>
        n.tags.some((t) => /review|risk|bug|qa/i.test(t)),
      );
      const rest = note.filter((n) => !reviewish.includes(n));
      return [...dec, ...reviewish, ...rest];
    }
    case "handoff":
      return interleave(dec, note);
    case "coding":
    default:
      return [...dec, ...note];
  }
}

function interleave(a: CaptureItem[], b: CaptureItem[]): CaptureItem[] {
  const out: CaptureItem[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]!);
    if (i < b.length) out.push(b[i]!);
  }
  return out;
}

/**
 * Budgeted get_active_context packing.
 * Priority: rules → brief → ranked recent decisions/notes.
 * Never dumps the full brain.
 */
export function getActiveContext(
  store: BrainStore,
  input: GetActiveContextInput,
): ActiveContextResult {
  const projectId = store.resolveProjectId(input.project_id);
  const project = store.getProject(projectId)!;
  const budget = Math.max(64, Math.floor(input.token_budget));
  const etag = store.contextEtag(projectId);
  const overhead = estimateTokens(UNTRUSTED_NOTICE) + 40;

  // Short-circuit when client already has this pack
  if (input.since_etag && input.since_etag === etag) {
    return {
      project_id: project.id,
      project_name: project.name,
      purpose: input.purpose,
      context_etag: etag,
      tokens_estimate: overhead,
      items_included: 0,
      items_omitted: 0,
      injected_summary: `${project.name} · up to date`,
      items: [],
      untrusted_notice: UNTRUSTED_NOTICE,
      up_to_date: true,
    };
  }

  const candidates: ContextPackItem[] = [];

  for (let i = 0; i < project.rules.length; i++) {
    const rule = project.rules[i]!;
    candidates.push({
      kind: "rule",
      id: `rule_${i}`,
      text: rule,
    });
  }

  if (project.brief.trim()) {
    candidates.push({
      kind: "brief",
      id: "brief",
      text: project.brief.trim(),
    });
  }

  const activeCaptures = filterSuperseded([...project.decisions, ...project.notes]);
  const decisions = activeCaptures.filter((c) => c.type === "decision");
  const notes = activeCaptures.filter((c) => c.type === "note");
  const ranked = rankCaptures(input.purpose, decisions, notes);
  for (const c of ranked) {
    candidates.push({
      kind: c.type,
      id: c.id,
      text: c.title ? `${c.title}: ${c.body}` : c.body,
      created_at: c.created_at,
      tags: c.tags,
    });
  }

  const included: ContextPackItem[] = [];
  let tokens = 0;
  let omitted = 0;

  let remaining = Math.max(32, budget - overhead);

  for (const item of candidates) {
    const cost = estimateTokens(itemText(item.kind, { text: item.text })) + 4;
    if (cost <= remaining) {
      included.push(item);
      remaining -= cost;
      tokens += cost;
    } else {
      omitted += 1;
    }
  }

  const ruleCount = included.filter((i) => i.kind === "rule").length;
  const decCount = included.filter((i) => i.kind === "decision").length;
  const noteCount = included.filter((i) => i.kind === "note").length;
  const hasBrief = included.some((i) => i.kind === "brief");

  const summaryParts = [
    project.name,
    hasBrief ? "brief" : null,
    ruleCount ? `${ruleCount} rule${ruleCount === 1 ? "" : "s"}` : null,
    decCount ? `${decCount} decision${decCount === 1 ? "" : "s"}` : null,
    noteCount ? `${noteCount} note${noteCount === 1 ? "" : "s"}` : null,
    omitted ? `${omitted} omitted` : null,
  ].filter(Boolean);

  const result: ActiveContextResult = {
    project_id: project.id,
    project_name: project.name,
    purpose: input.purpose,
    context_etag: etag,
    tokens_estimate: tokens + overhead,
    items_included: included.length,
    items_omitted: omitted,
    injected_summary: summaryParts.join(" · "),
    items: included,
    untrusted_notice: UNTRUSTED_NOTICE,
  };

  if (input.since_etag) {
    // MVP stub: full incremental diff not implemented; always return full pack.
    result.since_etag_stub = true;
    result.since_etag = input.since_etag;
  }

  return result;
}
