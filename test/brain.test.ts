import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getActiveContext } from "../src/brain/context.js";
import { BrainStore, slugify } from "../src/brain/store.js";
import { BODY_SOFT_CAP } from "../src/brain/types.js";

const dir = mkdtempSync(join(tmpdir(), "asideai-test-"));
const brainPath = join(dir, "brain.json");

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("makes stable slugs", () => {
    assert.equal(slugify("Acme Checkout"), "acme-checkout");
    assert.equal(slugify("  Hello!!! World  "), "hello-world");
  });
});

describe("BrainStore", () => {
  it("creates project with stable id and sets active by default", () => {
    const store = new BrainStore(brainPath);
    const p = store.createProject({
      name: "Acme Checkout",
      brief: "Guest checkout behind a flag",
      rules: ["Do not invent metrics"],
    });
    assert.equal(p.id, "acme-checkout");
    assert.equal(store.getActiveProjectId(), "acme-checkout");
    assert.equal(p.version, 1);
    assert.ok(store.contextEtag(p.id).length >= 8);
  });

  it("updates project and bumps version/etag", () => {
    const store = new BrainStore(brainPath);
    const before = store.contextEtag("acme-checkout");
    const p = store.updateProject({
      project_id: "acme-checkout",
      brief: "Updated brief",
      rules: ["Prefer design system"],
    });
    assert.equal(p.version, 2);
    assert.equal(p.brief, "Updated brief");
    assert.notEqual(store.contextEtag("acme-checkout"), before);
  });

  it("captures decision/note append-only with soft body cap", () => {
    const store = new BrainStore(brainPath);
    const long = "x".repeat(BODY_SOFT_CAP + 50);
    const { id, etag, item } = store.capture({
      type: "decision",
      title: "Flag",
      body: long,
      tags: ["mvp"],
    });
    assert.match(id, /^dec_/);
    assert.equal(item.body.length, BODY_SOFT_CAP);
    assert.ok(etag);

    const note = store.capture({
      type: "note",
      body: "Competitor prices add-ons separately",
      tags: ["competitive"],
      related_files: ["docs/pricing.md"],
      supersedes_id: id,
    });
    assert.match(note.id, /^note_/);
    assert.equal(note.item.supersedes_id, id);

    const p = store.getProject("acme-checkout")!;
    assert.equal(p.decisions.length, 1);
    assert.equal(p.notes.length, 1);
  });

  it("list and set active project", () => {
    const store = new BrainStore(brainPath);
    const other = store.createProject({
      name: "Other",
      set_active: false,
    });
    assert.equal(store.getActiveProjectId(), "acme-checkout");
    store.setActiveProject(other.id);
    assert.equal(store.getActiveProjectId(), other.id);
    const listed = store.listProjects();
    assert.ok(listed.some((p) => p.is_active && p.id === other.id));
    store.setActiveProject("acme-checkout");
  });
});

describe("getActiveContext", () => {
  it("packs rules→brief→captures within budget and never full-dumps", () => {
    const store = new BrainStore(brainPath);
    // Ensure many notes so some are omitted under a tiny budget
    for (let i = 0; i < 20; i++) {
      store.capture({
        type: "note",
        body: `Note number ${i} with enough text to cost tokens intentionally.`,
        tags: i % 5 === 0 ? ["review"] : [],
      });
    }

    const result = getActiveContext(store, {
      purpose: "coding",
      token_budget: 200,
      project_id: "acme-checkout",
    });

    assert.equal(result.project_id, "acme-checkout");
    assert.ok(result.context_etag);
    assert.ok(result.tokens_estimate <= 200 + 80); // overhead slack
    assert.ok(result.items_included >= 1);
    assert.ok(result.items_omitted >= 1);
    assert.ok(result.items.some((i) => i.kind === "rule" || i.kind === "brief"));
    assert.match(result.untrusted_notice, /untrusted/i);
    assert.ok(result.injected_summary.includes("Acme Checkout"));
  });

  it("stubs since_etag when provided", () => {
    const store = new BrainStore(brainPath);
    const result = getActiveContext(store, {
      purpose: "handoff",
      token_budget: 500,
      since_etag: "deadbeef",
    });
    assert.equal(result.since_etag_stub, true);
    assert.equal(result.since_etag, "deadbeef");
  });
});
