import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("load() throws on corrupt JSON", () => {
    const badPath = join(dir, "corrupt-brain.json");
    writeFileSync(badPath, "{not-json", "utf8");
    assert.throws(
      () => new BrainStore(badPath),
      (err: unknown) =>
        err instanceof Error && /corrupt brain file \(invalid JSON\)/i.test(err.message),
    );
  });

  it("load() throws on wrong version", () => {
    const badPath = join(dir, "bad-version-brain.json");
    writeFileSync(badPath, JSON.stringify({ version: 99, projects: {}, captures: {} }), "utf8");
    assert.throws(
      () => new BrainStore(badPath),
      (err: unknown) =>
        err instanceof Error && /expected version 1/i.test(err.message),
    );
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

  it("stubs since_etag when provided and different", () => {
    const store = new BrainStore(brainPath);
    const result = getActiveContext(store, {
      purpose: "handoff",
      token_budget: 500,
      since_etag: "deadbeef",
    });
    assert.equal(result.since_etag_stub, true);
    assert.equal(result.since_etag, "deadbeef");
    assert.notEqual(result.up_to_date, true);
  });

  it("returns up_to_date with empty items when since_etag matches", () => {
    const store = new BrainStore(brainPath);
    const etag = store.contextEtag("acme-checkout");
    const result = getActiveContext(store, {
      purpose: "coding",
      token_budget: 800,
      project_id: "acme-checkout",
      since_etag: etag,
    });
    assert.equal(result.up_to_date, true);
    assert.deepEqual(result.items, []);
    assert.equal(result.items_included, 0);
    assert.equal(result.items_omitted, 0);
    assert.equal(result.context_etag, etag);
    assert.equal(result.since_etag_stub, undefined);
    assert.equal(result.project_id, "acme-checkout");
    assert.match(result.untrusted_notice, /untrusted/i);
    assert.ok(result.tokens_estimate >= 0);
  });

  it("filters superseded captures out of the inject pack", () => {
    const isolated = join(dir, "supersede-brain.json");
    const store = new BrainStore(isolated);
    store.createProject({
      name: "Supersede Demo",
      project_id: "supersede-demo",
      brief: "Brief",
      rules: ["Rule one"],
    });
    const old = store.capture({
      type: "decision",
      body: "Old decision that will be superseded",
      title: "Old",
      project_id: "supersede-demo",
    });
    const newer = store.capture({
      type: "decision",
      body: "Replacement decision",
      title: "New",
      supersedes_id: old.id,
      project_id: "supersede-demo",
    });

    const result = getActiveContext(store, {
      purpose: "coding",
      token_budget: 2000,
      project_id: "supersede-demo",
    });

    const ids = result.items.map((i) => i.id);
    assert.ok(!ids.includes(old.id), "superseded capture should be excluded");
    assert.ok(ids.includes(newer.id), "superseding capture should remain");
  });
});
