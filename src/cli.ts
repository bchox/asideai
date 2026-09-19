#!/usr/bin/env node
/**
 * Minimal CLI for smoke-testing the brain without MCP.
 *
 * Usage:
 *   asideai create-project --name "Acme Checkout" [--brief "..."] [--rule "..."]
 *   asideai list-projects
 *   asideai set-active <project_id>
 *   asideai capture decision|note --body "..." [--title "..."] [--tag "..."]
 *   asideai capture --body "..." decision
 *   asideai context --purpose coding --budget 800
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getActiveContext } from "./brain/context.js";
import { BrainStore } from "./brain/store.js";
import type { CaptureType, ContextPurpose } from "./brain/types.js";

const CLI_OPTIONS = {
  name: { type: "string" as const },
  brief: { type: "string" as const },
  rule: { type: "string" as const, multiple: true },
  id: { type: "string" as const },
  body: { type: "string" as const },
  title: { type: "string" as const },
  tag: { type: "string" as const, multiple: true },
  file: { type: "string" as const, multiple: true },
  project: { type: "string" as const },
  supersedes: { type: "string" as const },
  purpose: { type: "string" as const },
  budget: { type: "string" as const },
  "since-etag": { type: "string" as const },
  help: { type: "boolean" as const },
  h: { type: "boolean" as const },
};

export type CliValues = {
  name?: string;
  brief?: string;
  rule?: string[];
  id?: string;
  body?: string;
  title?: string;
  tag?: string[];
  file?: string[];
  project?: string;
  supersedes?: string;
  purpose?: string;
  budget?: string;
  "since-etag"?: string;
  help?: boolean;
  h?: boolean;
};

export type ParsedCli = {
  command: string;
  positionals: string[];
  values: CliValues;
};

/**
 * Parse CLI argv with util.parseArgs (flags before or after positionals).
 * Rejects empty values and values that look like another --flag.
 */
export function parseCliArgs(argv: string[]): ParsedCli {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const t of tokens ?? []) {
    if (t.kind !== "option") continue;
    if (typeof t.value !== "string") continue;
    // Inline --body=... may intentionally start with dashes; only reject
    // separate-token values that look like another flag or are empty.
    if (t.inlineValue) {
      if (t.value === "") {
        throw new Error(`Missing value for --${t.name}`);
      }
      continue;
    }
    if (t.value === "" || t.value.startsWith("-")) {
      throw new Error(`Missing or invalid value for --${t.name}`);
    }
  }

  const command = positionals[0];
  if (!command) {
    throw new Error("missing command");
  }

  return {
    command,
    positionals: positionals.slice(1),
    values: values as CliValues,
  };
}

function usage(): never {
  console.log(`AsideAI CLI

Commands:
  create-project --name <name> [--brief <text>] [--rule <text>]... [--id <slug>]
  list-projects
  set-active <project_id>
  update-project <project_id> [--name <name>] [--brief <text>] [--rule <text>]...
  capture <decision|note> --body <text> [--title <text>] [--tag <t>]... [--file <path>]... [--project <id>]
  capture --body <text> <decision|note>   (flags may precede the type)
  context --purpose <coding|decision|handoff|review> --budget <n> [--project <id>]

Brain file: ~/.asideai/brain.json
`);
  process.exit(1);
  throw new Error("unreachable");
}

async function main() {
  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Error && err.message === "missing command") usage();
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
    return;
  }

  const { command, positionals, values } = parsed;
  if (values.help || values.h) usage();

  const store = new BrainStore();

  switch (command) {
    case "create-project": {
      const name = values.name;
      if (!name) usage();
      const project = store.createProject({
        name,
        brief: values.brief,
        rules: values.rule,
        project_id: values.id,
      });
      console.log(
        JSON.stringify(
          { id: project.id, name: project.name, etag: store.contextEtag(project.id) },
          null,
          2,
        ),
      );
      break;
    }
    case "list-projects": {
      console.log(JSON.stringify({ projects: store.listProjects() }, null, 2));
      break;
    }
    case "set-active": {
      const id = positionals[0];
      if (!id) usage();
      console.log(JSON.stringify(store.setActiveProject(id), null, 2));
      break;
    }
    case "update-project": {
      const id = positionals[0];
      if (!id) usage();
      const rules = values.rule;
      const project = store.updateProject({
        project_id: id,
        name: values.name,
        brief: values.brief,
        rules: rules?.length ? rules : undefined,
      });
      console.log(
        JSON.stringify(
          { id: project.id, version: project.version, etag: store.contextEtag(project.id) },
          null,
          2,
        ),
      );
      break;
    }
    case "capture": {
      const type = positionals[0] as CaptureType | undefined;
      const body = values.body;
      if ((type !== "decision" && type !== "note") || !body) usage();
      const result = store.capture({
        type,
        body,
        title: values.title,
        tags: values.tag,
        related_files: values.file,
        project_id: values.project,
        supersedes_id: values.supersedes,
      });
      console.log(JSON.stringify({ id: result.id, etag: result.etag }, null, 2));
      break;
    }
    case "context": {
      const purpose = (values.purpose ?? "coding") as ContextPurpose;
      const budget = Number(values.budget ?? "800");
      const result = getActiveContext(store, {
        purpose,
        token_budget: budget,
        project_id: values.project,
        since_etag: values["since-etag"],
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      usage();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
