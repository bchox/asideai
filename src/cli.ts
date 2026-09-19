#!/usr/bin/env node
/**
 * Minimal CLI for smoke-testing the brain without MCP.
 *
 * Usage:
 *   asideai create-project --name "Acme Checkout" [--brief "..."] [--rule "..."]
 *   asideai list-projects
 *   asideai set-active <project_id>
 *   asideai capture decision|note --body "..." [--title "..."] [--tag "..."]
 *   asideai context --purpose coding --budget 800
 */
import { getActiveContext } from "./brain/context.js";
import { BrainStore } from "./brain/store.js";
import type { CaptureType, ContextPurpose } from "./brain/types.js";

function usage(): never {
  console.log(`AsideAI CLI

Commands:
  create-project --name <name> [--brief <text>] [--rule <text>]... [--id <slug>]
  list-projects
  set-active <project_id>
  update-project <project_id> [--name <name>] [--brief <text>] [--rule <text>]...
  capture <decision|note> --body <text> [--title <text>] [--tag <t>]... [--file <path>]... [--project <id>]
  context --purpose <coding|decision|handoff|review> --budget <n> [--project <id>]

Brain file: ~/.asideai/brain.json
`);
  process.exit(1);
  throw new Error("unreachable");
}

function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1]) {
      out.push(argv[++i]!);
    }
  }
  return out;
}

function flagValue(argv: string[], name: string): string | undefined {
  return flagValues(argv, name)[0];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || hasFlag(argv, "help") || hasFlag(argv, "h")) usage();

  const store = new BrainStore();

  switch (cmd) {
    case "create-project": {
      const name = flagValue(argv, "name");
      if (!name) usage();
      const project = store.createProject({
        name,
        brief: flagValue(argv, "brief"),
        rules: flagValues(argv, "rule"),
        project_id: flagValue(argv, "id"),
      });
      console.log(JSON.stringify({ id: project.id, name: project.name, etag: store.contextEtag(project.id) }, null, 2));
      break;
    }
    case "list-projects": {
      console.log(JSON.stringify({ projects: store.listProjects() }, null, 2));
      break;
    }
    case "set-active": {
      const id = argv[1];
      if (!id) usage();
      console.log(JSON.stringify(store.setActiveProject(id), null, 2));
      break;
    }
    case "update-project": {
      const id = argv[1];
      if (!id) usage();
      const rules = flagValues(argv, "rule");
      const project = store.updateProject({
        project_id: id,
        name: flagValue(argv, "name"),
        brief: flagValue(argv, "brief"),
        rules: rules.length ? rules : undefined,
      });
      console.log(JSON.stringify({ id: project.id, version: project.version, etag: store.contextEtag(project.id) }, null, 2));
      break;
    }
    case "capture": {
      const type = argv[1] as CaptureType;
      const body = flagValue(argv, "body");
      if ((type !== "decision" && type !== "note") || !body) usage();
      const result = store.capture({
        type,
        body,
        title: flagValue(argv, "title"),
        tags: flagValues(argv, "tag"),
        related_files: flagValues(argv, "file"),
        project_id: flagValue(argv, "project"),
        supersedes_id: flagValue(argv, "supersedes"),
      });
      console.log(JSON.stringify({ id: result.id, etag: result.etag }, null, 2));
      break;
    }
    case "context": {
      const purpose = (flagValue(argv, "purpose") ?? "coding") as ContextPurpose;
      const budget = Number(flagValue(argv, "budget") ?? "800");
      const result = getActiveContext(store, {
        purpose,
        token_budget: budget,
        project_id: flagValue(argv, "project"),
        since_etag: flagValue(argv, "since-etag"),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
