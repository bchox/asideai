import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BrainStore } from "../src/brain/store.js";
import { createToolHandlers } from "../src/mcp/tools.js";

const dir = mkdtempSync(join(tmpdir(), "asideai-tools-"));
const brainPath = join(dir, "brain.json");

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createToolHandlers", () => {
  it("returns isError for capture with missing/unknown project", async () => {
    const store = new BrainStore(brainPath);
    store.createProject({ name: "Tools Project", project_id: "tools-project" });
    const handlers = createToolHandlers(store);

    const result = await handlers.capture({
      type: "decision",
      body: "hello",
      project_id: "does-not-exist",
    });

    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Unknown project_id/i);
  });

  it("returns isError for invalid capture (empty body)", async () => {
    const store = new BrainStore(brainPath);
    const handlers = createToolHandlers(store);

    const result = await handlers.capture({
      type: "note",
      body: "   ",
      project_id: "tools-project",
    });

    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /body is required/i);
  });
});
