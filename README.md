# AsideAI

A shared brain with a harness that sits *beside* ChatGPT, Claude, Codex, Grok, Cursor, and the next model — so switching AIs feels continuous instead of starting over.

> Help me keep one working identity across every AI I use, without living inside a new chat app.

## Status

Early product definition. MVP is locked around **inject → capture → switch → trust**, with **MCP / coding-agent inject** as the first harness surface.

## MVP (locked)

1. One project brain — brief, rules, decisions, notes (local-first)
2. Budgeted MCP inject — `get_active_context` with purpose + token budget + `context_etag`
3. MCP project tools — `list_projects`, `set_active_project` (active is a default; pass `project_id` when parallel)
4. Structured capture — `capture` with title, soft-capped body, tags, optional `supersedes_id`; returns etag
5. Continuity across two MCP clients in one day without dumping the whole brain

Browser companion comes later. AsideAI is not another chatbot.

## License

MIT
