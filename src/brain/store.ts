import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BODY_SOFT_CAP,
  type BrainState,
  type CaptureInput,
  type CaptureItem,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
} from "./types.js";

const DEFAULT_DIR = join(homedir(), ".asideai");
const DEFAULT_PATH = join(DEFAULT_DIR, "brain.json");

function emptyState(): BrainState {
  return {
    version: 1,
    active_project_id: null,
    projects: {},
    captures: {},
  };
}

/** Slugify a display name into a stable project_id. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "project";
}

function softCapBody(body: string): string {
  if (body.length <= BODY_SOFT_CAP) return body;
  return body.slice(0, BODY_SOFT_CAP);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Local-first JSON brain store under ~/.asideai/brain.json.
 * Atomic write via temp file + rename. No embeddings, no multiplayer.
 */
export class BrainStore {
  readonly path: string;
  private state: BrainState;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    this.state = this.load();
  }

  private load(): BrainState {
    try {
      if (!existsSync(this.path)) return emptyState();
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as BrainState;
      if (!parsed || parsed.version !== 1) return emptyState();
      parsed.projects ??= {};
      parsed.captures ??= {};
      return parsed;
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  /** Hash of project core state + capture ids for that project (etag). */
  contextEtag(projectId: string): string {
    const p = this.state.projects[projectId];
    if (!p) return "missing";
    const captureIds = Object.values(this.state.captures)
      .filter((c) => c.project_id === projectId)
      .map((c) => c.id)
      .sort();
    const payload = JSON.stringify({
      id: p.id,
      name: p.name,
      brief: p.brief,
      rules: p.rules,
      version: p.version,
      captures: captureIds,
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  listProjects(query?: string): Array<{
    id: string;
    name: string;
    is_active: boolean;
    brief: string;
    version: number;
  }> {
    const q = query?.toLowerCase().trim();
    return Object.values(this.state.projects)
      .filter((p) => {
        if (!q) return true;
        return (
          p.id.includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.brief.toLowerCase().includes(q)
        );
      })
      .map((p) => ({
        id: p.id,
        name: p.name,
        is_active: this.state.active_project_id === p.id,
        brief: p.brief,
        version: p.version,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(projectId: string): Project | undefined {
    return this.state.projects[projectId];
  }

  getActiveProjectId(): string | null {
    return this.state.active_project_id;
  }

  /** Resolve project_id or fall back to the single active default. */
  resolveProjectId(projectId?: string): string {
    if (projectId) {
      if (!this.state.projects[projectId]) {
        throw new Error(`Unknown project_id: ${projectId}`);
      }
      return projectId;
    }
    if (!this.state.active_project_id) {
      throw new Error("No active project. Create one or pass project_id.");
    }
    return this.state.active_project_id;
  }

  setActiveProject(projectId: string): { ok: true; project: { id: string; name: string } } {
    const p = this.state.projects[projectId];
    if (!p) throw new Error(`Unknown project_id: ${projectId}`);
    this.state.active_project_id = projectId;
    this.persist();
    return { ok: true, project: { id: p.id, name: p.name } };
  }

  createProject(input: CreateProjectInput): Project {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");

    let id = (input.project_id?.trim() || slugify(name)).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`Invalid project_id slug: ${id}`);
    }
    if (this.state.projects[id]) {
      // Uniqueness: append short suffix
      let n = 2;
      while (this.state.projects[`${id}-${n}`]) n += 1;
      id = `${id}-${n}`;
    }

    const ts = nowIso();
    const project: Project = {
      id,
      name,
      brief: input.brief?.trim() ?? "",
      rules: (input.rules ?? []).map((r) => r.trim()).filter(Boolean),
      decisions: [],
      notes: [],
      created_at: ts,
      updated_at: ts,
      version: 1,
    };
    this.state.projects[id] = project;

    const setActive =
      input.set_active !== false &&
      (this.state.active_project_id === null || input.set_active === true);
    if (setActive || this.state.active_project_id === null) {
      this.state.active_project_id = id;
    }

    this.persist();
    return project;
  }

  updateProject(input: UpdateProjectInput): Project {
    const p = this.state.projects[input.project_id];
    if (!p) throw new Error(`Unknown project_id: ${input.project_id}`);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error("name cannot be empty");
      p.name = name;
    }
    if (input.brief !== undefined) p.brief = input.brief.trim();
    if (input.rules !== undefined) {
      p.rules = input.rules.map((r) => r.trim()).filter(Boolean);
    }
    p.updated_at = nowIso();
    p.version += 1;
    this.persist();
    return p;
  }

  capture(input: CaptureInput): { id: string; etag: string; item: CaptureItem } {
    const projectId = this.resolveProjectId(input.project_id);
    const p = this.state.projects[projectId]!;

    const body = softCapBody(input.body.trim());
    if (!body) throw new Error("body is required");
    if (input.type !== "decision" && input.type !== "note") {
      throw new Error('type must be "decision" or "note"');
    }

    if (input.supersedes_id) {
      const prev = this.state.captures[input.supersedes_id];
      if (!prev || prev.project_id !== projectId) {
        throw new Error(`supersedes_id not found in project: ${input.supersedes_id}`);
      }
    }

    const prefix = input.type === "decision" ? "dec" : "note";
    const id = `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const item: CaptureItem = {
      id,
      type: input.type,
      title: (input.title ?? "").trim(),
      body,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      related_files: (input.related_files ?? []).map((f) => f.trim()).filter(Boolean),
      supersedes_id: input.supersedes_id,
      created_at: nowIso(),
      project_id: projectId,
    };

    this.state.captures[id] = item;
    if (item.type === "decision") p.decisions.push(item);
    else p.notes.push(item);
    p.updated_at = item.created_at;
    p.version += 1;
    this.persist();

    return { id, etag: this.contextEtag(projectId), item };
  }

  getCaptures(projectId: string): CaptureItem[] {
    return Object.values(this.state.captures)
      .filter((c) => c.project_id === projectId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  /** Test helper: replace in-memory state and persist. */
  replaceState(state: BrainState): void {
    this.state = state;
    this.persist();
  }

  getState(): BrainState {
    return this.state;
  }
}
