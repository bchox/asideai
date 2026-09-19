import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("allows flags before positional type for capture", () => {
    const parsed = parseCliArgs(["capture", "--body", "Ship it", "decision"]);
    assert.equal(parsed.command, "capture");
    assert.deepEqual(parsed.positionals, ["decision"]);
    assert.equal(parsed.values.body, "Ship it");
  });

  it("allows flags after positional type for capture", () => {
    const parsed = parseCliArgs(["capture", "decision", "--body", "Ship it", "--tag", "mvp"]);
    assert.equal(parsed.command, "capture");
    assert.deepEqual(parsed.positionals, ["decision"]);
    assert.equal(parsed.values.body, "Ship it");
    assert.deepEqual(parsed.values.tag, ["mvp"]);
  });

  it("rejects treating another --flag as a value", () => {
    assert.throws(
      () => parseCliArgs(["capture", "--body", "--title", "x"]),
      (err: unknown) =>
        err instanceof Error && /Missing or invalid value for --body/i.test(err.message),
    );
  });

  it("parses create-project with multiple --rule flags", () => {
    const parsed = parseCliArgs([
      "create-project",
      "--name",
      "Acme",
      "--rule",
      "a",
      "--rule",
      "b",
    ]);
    assert.equal(parsed.command, "create-project");
    assert.equal(parsed.values.name, "Acme");
    assert.deepEqual(parsed.values.rule, ["a", "b"]);
  });
});
