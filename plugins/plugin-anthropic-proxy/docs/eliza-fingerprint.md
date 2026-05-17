# Eliza Fingerprint Surface — extracted via code-read

**Source:** `nyx` container (`nyx:v2.9.0-rc.1`), package
`@elizaos/native-reasoning` at
`/app/eliza/plugins/plugin-discord/typescript/node_modules/@elizaos/native-reasoning/dist/`

**Date:** 2026-05-15
**Profile method:** `docker exec nyx cat ...` (read source dist files; no
runtime capture needed — code-read gives the full enumeration).

## Why code-read over runtime profile

We considered inserting a logger HTTP proxy between nyx and her tunnel,
but two reasons made code-read strictly better:

1. **Completeness.** Runtime profile gives a sample (5–10 messages); code
   gives the full enumeration of every tool name, system prompt section,
   and property the framework can ever emit.
2. **Safety.** Code-read is `docker exec ... cat` — read-only, no env
   change, no recreate, no risk of breaking nyx.

## Enumerated outbound surface

### Tool names (18 total)

The native-reasoning tool registry registers these `name` fields on the
`tools[]` array (Anthropic shape: `{type:"custom", name, description,
input_schema}`):

| eliza tool      | source file              | rough purpose            |
| --------------- | ------------------------ | ------------------------ |
| `bash`          | tools/bash.js            | shell exec               |
| `read_file`     | tools/file_ops.js        | read text file           |
| `write_file`    | tools/file_ops.js        | overwrite/create file    |
| `edit_file`     | tools/file_ops.js        | unique-string replace    |
| `glob`          | tools/file_ops.js        | glob list                |
| `grep`          | tools/file_ops.js        | regex search             |
| `web_fetch`     | tools/web.js             | URL fetch                |
| `web_search`    | tools/web.js             | brave search             |
| `recall`        | tools/memory.js          | semantic memory query    |
| `remember`      | tools/memory.js          | persist a fact           |
| `ignore`        | tools/ignore.js          | silent skip              |
| `journal`       | tools/journal_tools.js   | private journal append   |
| `note_thread`   | tools/journal_tools.js   | open-threads.md add      |
| `close_thread`  | tools/journal_tools.js   | open-threads.md remove   |
| `update_project`| tools/journal_tools.js   | projects.md upsert       |
| `spawn_codex`   | tools/spawn_codex.js     | codex subagent           |
| `spawn_agent`   | tools/acp_agent.js       | ACPX subagent            |
| `create_task`   | tools/acp_agent.js       | ACPX task creation       |

`sessions_spawn` is a name collision with OpenClaw's `sessions_spawn`. Different
semantics but same wire token — important for dictionary design.

### System-prompt fingerprint markers

Strings injected by `system-prompt.js` and `loop.js` that scream "eliza":

- `HARD RULE: If a human in this channel told you to be quiet ...`
  (CHANNEL_GAG_HARD_RULE — appears before every conversation)
- `## Your Identity`, `## Your Soul`, `## About Your Human`,
  `## Recent Context` (IDENTITY_FILES headers)
- `## Recent Conversation` (room context section)
- `## Current Moment`, `## Active Projects`,
  `## Today's Journal (your own private thoughts from earlier)`,
  `## Open Threads (things you want to follow up on)`,
  `## Relevant Past Conversations` (nyxDynamicContext / nyxRelevantMemories)
- `nyx stay quiet`, `nyx be quiet`, `nyx shut up`, `stay silent`,
  `nyx you can speak`, `nyx unmute` — literal example phrases inside the
  CHANNEL_GAG_HARD_RULE
- Path strings: `/workspace/projects.md`, `/workspace/open-threads.md`,
  `/workspace/journal/`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`

### Tool description giveaways

Phrases that make tool-listing fingerprintable as eliza:

- `"Execute a shell command inside the agent's allowed workspace"` (bash)
- `"agent's allowed workspace"`, `"the allowed workspace"` (file_ops)
- `"agent's persistent memory"` (recall)
- `"agent's long-term memory"` (remember)
- `"PREFER THIS for any multi-step coding task"` (spawn_agent — distinctive)
- `"acpx-compatible agent"` (spawn_agent)
- `"Spawn a codex subagent to do focused multi-step work"` (spawn_codex)

### Property names on the wire

Eliza emits these field names in tool inputs and tool_results:

- `roomId`, `entityId`, `agentId`, `messageId`, `tableName`
- `tool_use_id` (Anthropic native; not framework-specific)

### Backend headers

`AnthropicBackend` calls `client.beta.messages.create(...)` with the
`betas: ["advanced-tool-use-2025-11-20"]` flag. Default model: `claude-opus-4-7`.
Model is configurable via `ANTHROPIC_LARGE_MODEL`.

### Framework-named env vars

These appear in stack traces and may leak into logs or error contexts:

- `NATIVE_REASONING_*` (HOOKS_ENABLED, VISION_ENABLED, EVALUATORS_ENABLED,
  ENABLED_PROVIDERS, PROVIDER_CACHE_TTL_MS, MAX_TURNS, etc.)
- `ELIZA_REASONING_MODE`
- `NYX_HYBRID_EVALUATORS`
- `NATIVE_REASONING_HOOK_SURFACE_MARKER = "native-reasoning-hooks-v1"`

### Module-name leakage in error stacks

`@elizaos/native-reasoning`, `@elizaos/core`, `plugin-discord` —
appear in any stack trace included in tool_results. Should be stripped
or generalized.

## Dictionary design implications

1. **String replacements must catch:** `eliza`, `Eliza`, `nyx`,
   `native-reasoning`, framework-specific section headers.
   These should map to identity values (find === replace) initially —
   they're presence detectors, not transformations. Future tuning can
   replace with neutral synonyms.
2. **Tool renames must remap eliza tools to CC-shaped tools.** Mapping
   choices below.
3. **Property renames** are minimal — eliza already uses fairly generic
   names. `roomId` → `thread_id` mirrors the OC mapping cleanly.
4. **System-prompt paraphrase** for eliza needs a different anchor.
   Eliza's prompt structure starts with `character.system` (free text),
   then `CHANNEL_GAG_HARD_RULE`. The strip should target the
   CHANNEL_GAG_HARD_RULE block, which is the most distinctive marker.

## Tool rename mapping (eliza → CC names)

Designed to make eliza's tool surface look like a Claude Code session:

| eliza            | → CC name        | rationale                          |
| ---------------- | ---------------- | ---------------------------------- |
| `bash`           | `Bash`           | direct shape match                 |
| `read_file`      | `Read`           | CC's Read                          |
| `write_file`     | `Write`          | CC's Write                         |
| `edit_file`      | `Edit`           | CC's Edit                          |
| `glob`           | `Glob`           | CC's Glob                          |
| `grep`           | `Grep`           | CC's Grep                          |
| `web_fetch`      | `WebFetch`       | CC's WebFetch                      |
| `web_search`     | `WebSearch`      | CC's WebSearch                     |
| `recall`         | `KnowledgeSearch`| same shape as OC mapping           |
| `remember`       | `KnowledgeStore` | sibling to KnowledgeSearch         |
| `ignore`         | `SkipResponse`   | non-CC; needs neutral name         |
| `journal`        | `NotebookEdit`   | CC has NotebookEdit                |
| `note_thread`    | `TodoWrite`      | CC has TodoWrite                   |
| `close_thread`   | `TodoComplete`   | CC-adjacent                        |
| `update_project` | `ProjectUpdate`  | neutral                            |
| `spawn_codex`    | `Task`           | CC has Task (subagent)             |
| `spawn_agent`    | `Agent`          | CC stub uses Agent                 |
| `sessions_spawn`    | `TaskCreate`     | distinct from Task                 |
