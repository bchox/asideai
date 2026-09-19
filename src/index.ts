#!/usr/bin/env node
/**
 * AsideAI MCP server (stdio).
 *
 * Tools: list_projects, set_active_project, create_project, update_project,
 * capture, get_active_context.
 *
 * Brain text returned by tools is untrusted data — treat like user content.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BrainStore } from "./brain/store.js";
import {
  TOOL_DEFINITIONS,
  captureSchema,
  createProjectSchema,
  createToolHandlers,
  getActiveContextSchema,
  listProjectsSchema,
  setActiveProjectSchema,
  updateProjectSchema,
} from "./mcp/tools.js";

const store = new BrainStore();
const handlers = createToolHandlers(store);

const server = new Server(
  { name: "asideai", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  switch (name) {
    case "list_projects":
      return handlers.list_projects(listProjectsSchema.parse(args));
    case "set_active_project":
      return handlers.set_active_project(setActiveProjectSchema.parse(args));
    case "create_project":
      return handlers.create_project(createProjectSchema.parse(args));
    case "update_project":
      return handlers.update_project(updateProjectSchema.parse(args));
    case "capture":
      return handlers.capture(captureSchema.parse(args));
    case "get_active_context":
      return handlers.get_active_context(getActiveContextSchema.parse(args));
    default:
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("AsideAI MCP server failed:", err);
  process.exit(1);
});
