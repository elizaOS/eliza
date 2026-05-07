# Action implementation contract — plugin-coding-tools

This document is the brief every action-implementing agent operates from.
Read it once, then implement the action(s) you were assigned.

## Files you may write

- `src/actions/<your-action>.ts` — the action implementation
- `src/actions/__tests__/<your-action>.test.ts` — vitest tests

**Do not modify** anything else. The plugin scaffold (services, types,
providers, build config, index.ts) is already wired up and depends on the
exact export names listed in `src/actions/index.ts`.

## Required export shape

```ts
import type { Action } from "@elizaos/core";

export const <yourActionName>: Action = { /* ... */ };
```

The export name must match the entry in `src/actions/index.ts`.

## Action skeleton

```ts
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger as coreLogger,
} from "@elizaos/core";

import {
  failureToActionResult,
  readNumberParam,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS, CODING_TOOLS_LOG_PREFIX } from "../types.js";
// import services from "../services/index.js" as needed

export const myAction: Action = {
  name: "MY_ACTION",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  similes: ["MY_SIMILE"],
  description: "One-paragraph description for the planner.",
  descriptionCompressed: "Short tagline (under 80 chars).",
  parameters: [
    { name: "file_path", description: "Absolute path", required: true,
      schema: { type: "string" } },
    // ...
  ],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    const disable = runtime.getSetting?.("CODING_TOOLS_DISABLE");
    if (disable === true || disable === "true" || disable === "1") return false;
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // 1. Parse params via readStringParam / readNumberParam / etc.
    // 2. Validate via SandboxService etc.
    // 3. Do the work.
    // 4. Return successActionResult(text, data) | failureToActionResult(failure)
    // 5. Optionally invoke callback({ text, source: "coding-tools" })
  },
};
```

## Available services (resolve via `runtime.getService<T>(serviceType)`)

- `FileStateService` (`FILE_STATE_SERVICE`) — `recordRead`, `recordWrite`,
  `assertWritable`, `invalidate`. Use this for mtime-gated Write/Edit.
- `SandboxService` (`SANDBOX_SERVICE`) — `validatePath(conversationId, abs)`,
  `validateCommand(cmd)`, `addRoot`/`removeRoot`, `rootsFor`. **Always validate
  paths through this before reading or writing.**
- `SessionCwdService` (`SESSION_CWD_SERVICE`) — `getCwd`, `setCwd`,
  `pushWorktree`, `popWorktree`. Use as default when an optional `path`/`cwd`
  param is omitted.
- `RipgrepService` (`RIPGREP_SERVICE`) — `search(options, mode)`. GREP only.
- `ShellTaskService` (`SHELL_TASK_SERVICE`) — `start_`, `get`, `waitFor`,
  `stop_`. BASH backgrounding + TASK_OUTPUT + TASK_STOP.

## Path & cwd rules (NON-NEGOTIABLE)

- **READ / WRITE / EDIT / NOTEBOOK_EDIT** — `file_path` is required and must
  be an absolute path. Reject relative paths via `SandboxService.validatePath`.
- **GLOB / GREP / LS** — `path` parameter optional. When omitted, default to
  `SessionCwdService.getCwd(conversationId)`. When provided, must be absolute,
  validated through SandboxService.
- **BASH** — runs with `cwd` defaulting to `SessionCwdService.getCwd(...)`.
  Optional `cwd` parameter overrides; must be absolute and within roots.
- **ENTER_WORKTREE** — call `SandboxService.addRoot` and
  `SessionCwdService.pushWorktree` so the new path is reachable.

## Conversation ID

`conversationId` for service keys = `message.roomId` (string-coerced). If
`message.roomId` is missing, fail with `failureToActionResult({reason: "missing_param", message: "no roomId"})`.

## Error handling

Use `failureToActionResult` for all failures. Don't throw out of the handler.
Always return `ActionResult` with `success: true | false` and a `text` field.

## Tests

Use vitest. Mock the runtime where needed via a small helper or inline. Test
both happy path and one or two failure cases (path outside roots, file not
read first, etc.). Tests live in `src/actions/__tests__/<name>.test.ts`.

Run with `bun run test --filter=<your-action>` from the plugin dir.

## Imports

- `@elizaos/core` for types, logger, Service.
- `node:fs/promises`, `node:path`, `node:child_process`, `node:crypto` for
  Node APIs. No external deps beyond what package.json already declares
  (`@vscode/ripgrep` is the only runtime dep).
- Always use `.js` extension on relative imports (ESM rule).

## Style

- Match the style of `plugin-executecode/src/action.ts`.
- Use `coreLogger.debug` / `.warn` for diagnostic logs prefixed with
  `CODING_TOOLS_LOG_PREFIX`.
- No comments narrating obvious code. Only comment non-obvious WHY.

## When in doubt

Read the spec for your action in this brief, look at how Claude Code does it
(`claude-code/src/tools/<ToolName>/`), then implement the simplest correct
thing that satisfies both. Do not invent extra parameters.
