# ACPX_REFERENCE.md

Canonical reference for the `acpx` CLI as consumed by `@elizaos/plugin-agent-orchestrator`. Authoritative source: `.research/acpx-docs/` (ocplatform/acpx README, docs/CLI.md, skills/acpx/SKILL.md, ACP coverage roadmap). All citations refer to those files.

## 1. Overview

`acpx` is a headless ACP (Agent Client Protocol) CLI client. Its purpose: provide a structured-protocol surface for AI agent-to-agent communication, replacing PTY-based scraping of CLI assistants.

### What it is

- One CLI surface across 15+ Agent Client Protocol (ACP)-compatible coding agents (codex, claude, gemini, cursor, copilot, qwen, droid, kimi, kilocode, iflow, qoder, trae, opencode, kiro, pi).
- Persistent named sessions per repo (cwd-scoped, optionally named).
- Prompt queueing, cooperative cancel, crash reconnect.
- Three output formats (text, json, quiet) with NDJSON-on-stdout for automation.
- Local config + per-project config + CLI flag override hierarchy.
- Flow runner for multi-step typescript workflows (out of scope for v0.1.0 of plugin-acp).

### What we target

- Version: latest (`acpx@latest` on npm). Alpha. Public API may change before 1.0.
- Install: `npm install -g acpx@latest` or `npx acpx@latest <args>`.
- State: `~/.acpx/` (sessions, flows, config). Uses OS home directory; inheritable.
- Authoritative cite: `.research/acpx-docs/README.md` lines 1-50.

### What `@elizaos/plugin-agent-orchestrator` uses

- `acpx --format json <agent> exec ...` for one-shot tasks (CREATE_TASK).
- `acpx --format json <agent> sessions new --name X` for session creation.
- `acpx --format json <agent> -s X "<prompt>"` for sending to an existing session.
- `acpx <agent> cancel -s X` for cooperative cancel.
- `acpx <agent> sessions close X` for soft-close.
- `acpx <agent> sessions list` and `acpx <agent> sessions show X` for diagnostics.
- `acpx <agent> status` for liveness checks.
- The `--agent <command>` escape hatch may be used in the future for custom adapters; v0.1.0 only uses built-in agents.

### Install verification status

**TODO verify** — install attempted, status reporting in W2 worker output. If install failed, fall back to documented behavior. If install succeeded, real `acpx --version` output appended below.

```
TODO: paste real acpx --version after install
TODO: paste real acpx --help after install
TODO: paste real acpx --format json codex exec "hi" sample (first 30 lines)
```

## 2. CLI surface

### Grammar (cite: docs_CLI.md lines 19-44)

```
acpx [global_options] [prompt_text...]
acpx [global_options] prompt [prompt_options] [prompt_text...]
acpx [global_options] exec [prompt_options] [prompt_text...]
acpx [global_options] flow run <file> [--input-json <json> | --input-file <path>] [--default-agent <name>]
acpx [global_options] cancel [-s <name>]
acpx [global_options] set-mode <mode> [-s <name>]
acpx [global_options] set <key> <value> [-s <name>]
acpx [global_options] status [-s <name>]
acpx [global_options] sessions [list | new [--name <name>] | ensure [--name <name>] | close [name] | show [name] | history [name] [--limit <count>] | prune [--dry-run] [--before <date>] [--older-than <days>] [--include-history]]
acpx [global_options] config [show | init]

acpx [global_options] <agent> [prompt_options] [prompt_text...]
acpx [global_options] <agent> prompt ...
acpx [global_options] <agent> exec ...
acpx [global_options] <agent> cancel ...
acpx [global_options] <agent> set-mode ...
acpx [global_options] <agent> set ...
acpx [global_options] <agent> status ...
acpx [global_options] <agent> sessions ...
```

`<agent>` may be:
- A built-in friendly name: `pi`, `openclaw`, `codex`, `claude`, `gemini`, `cursor`, `copilot`, `droid`, `qwen`, `kilocode`, `iflow`, `kimi`, `kiro`, `qoder`, `trae`, `opencode`. (cite: `docs_CLI.md` agent commands section + README.md adapter table)
- An unknown token (treated as a raw command).
- Overridden by `--agent <command>` escape hatch.

When `<agent>` is omitted from the top-level command, `acpx` defaults to **codex**. (cite: `docs_CLI.md` lines 60-62)

### Global options (cite: docs_CLI.md lines 110-130)

| Option | Description | Notes |
|---|---|---|
| `--agent <command>` | Raw ACP agent command (escape hatch) | Cannot combine with positional agent. |
| `--cwd <dir>` | Working directory | Defaults to current dir. Stored as absolute path for scoping. |
| `--approve-all` | Auto-approve all permissions | Mutex with other approval flags. |
| `--approve-reads` | Auto-approve reads/searches, prompt for others | Default. |
| `--deny-all` | Deny all permissions | |
| `--format <fmt>` | Output format: `text` (default), `json`, `quiet` | |
| `--suppress-reads` | Replace raw read payloads with `[read output suppressed]` | Useful in `text` and `json` modes. |
| `--json-strict` | Strict JSON mode | Requires `--format json`. Suppresses non-JSON stderr. |
| `--no-terminal` | Disable ACP terminal capability | Advertises `clientCapabilities.terminal: false`. |
| `--non-interactive-permissions <policy>` | `deny` (default) or `fail` | When approval prompt cannot be shown. |
| `--timeout <seconds>` | Max wait time for agent response | Decimal seconds allowed. |
| `--ttl <seconds>` | Queue owner idle TTL | Default 300. `0` disables. |
| `--model <id>` | Set agent model | Adapter-specific. Some adapters fail clearly if model not supported. |
| `--verbose` | Enable verbose logs | Stderr. |

**Permission flag rule**: exactly one of `--approve-all`, `--approve-reads`, `--deny-all` may be passed. (cite: docs_CLI.md line 132)

### Prompt options

When invoking a prompt subcommand or implicit prompt:

| Option | Description |
|---|---|
| `-s, --session <name>` | Use a named session within the cwd scope. |
| `--no-wait` | Queue prompt and return immediately (queue ack only). |
| `-f, --file <path>` | Read prompt text from file. `-` means stdin. |

(cite: docs_CLI.md lines 47-58)

### Subcommands

#### `prompt` (explicit)

Cite: docs_CLI.md lines 218-242.

Persistent-session prompt:

- Finds existing session for scope key `(agentCommand, cwd, name?)`.
- Does NOT auto-create. Missing scope exits with code 4 and guidance.
- Sends prompt on resumed/new session (well, `session/load` flow; if pid dead, respawns transparently).
- Queues if a prompt is already running for that session — submits via IPC to the running queue owner.
- Default: blocks until completion.
- `--no-wait`: returns after queue acknowledgement.
- Updates session metadata after completion.

Implicit prompt form: `acpx [global_options] <agent> [prompt_options] [prompt_text...]` is equivalent to `acpx [global_options] <agent> prompt [...]`.

#### `exec` (one-shot)

Cite: docs_CLI.md lines 244-262.

```
acpx <agent> exec [prompt_options] [prompt_text...]
```

- Creates a temporary ACP session.
- Sends prompt once.
- Does NOT write/use a saved session record.
- Supports prompt text from args, stdin, `--file <path>`, `--file -`.

**For plugin-acp**: this is the right choice for SPAWN_AGENT + SEND_TO_AGENT one-shot flows IF we want zero session persistence. For CREATE_TASK we use `sessions new` then explicit `prompt`.

#### `cancel`

Cite: docs_CLI.md lines 264-278.

```
acpx <agent> cancel [-s <name>]
```

- Sends cooperative `session/cancel` through queue-owner IPC when a prompt is running.
- If no prompt running, prints `nothing to cancel` and exits 0.

#### `set-mode`

Cite: docs_CLI.md lines 280-298.

```
acpx <agent> set-mode <mode> [-s <name>]
```

- Calls ACP `session/set_mode`.
- `<mode>` is adapter-defined (not standardized).
- Unsupported mode ids rejected by adapter (often `Invalid params`).
- Routes through queue-owner IPC if owner active; falls back to direct reconnect.

#### `set`

Cite: docs_CLI.md lines 300-318.

```
acpx <agent> set <key> <value> [-s <name>]
```

- Calls ACP `session/set_config_option`.
- Special case: `set model <id>` is intercepted to call `session/set_model` (some adapters support set_model but not set_config_option for model changes).

#### `sessions`

Cite: docs_CLI.md lines 320-368.

| Sub | Behavior |
|---|---|
| `sessions` or `sessions list` | List all saved sessions for `agentCommand` (across all cwds). |
| `sessions new` | Fresh cwd-scoped default session. Soft-closes prior open in scope. |
| `sessions new --name X` | Fresh named session for cwd. |
| `sessions ensure` | Returns nearest matching active session, or creates one for cwd. |
| `sessions ensure --name X` | Same, named. |
| `sessions close [name]` | Soft-closes. Default = cwd default; with name = named. |
| `sessions show [name]` | Displays stored metadata. |
| `sessions history [name] [--limit N]` | Recent turn history previews. Default limit 20. |
| `sessions prune [--dry-run] [--before <date>] [--older-than <days>] [--include-history]` | Delete closed session records. With `--include-history`, also delete event stream files. |

**For plugin-acp's SessionStore**: we duplicate state on our side because `acpx` state is per-process and we want eliza-runtime control over it. But we also call `acpx sessions show` to verify acpx's internal state when reattaching.

#### `status`

Cite: docs_CLI.md lines 370-388.

```
acpx <agent> status [-s <name>]
```

Shows local process status for the cwd-scoped session:
- Status: `running` | `idle` | `dead` | `no-session`.
- Session id, agent command, pid.
- Uptime when running.
- Last prompt timestamp.
- Last known exit code/signal when dead.

`idle` = persistent session saved & resumable, no queue owner running. Next prompt starts a queue owner and reconnects.

PID-based liveness check (`kill(pid, 0)` semantics).

#### `config`

Cite: docs_CLI.md lines 390-430.

```
acpx config show
acpx config init
```

- `config show`: prints resolved config from global + project (CLI flags override).
- `config init`: writes default global template if missing.

Config file paths:
- Global: `~/.acpx/config.json`
- Project: `<cwd>/.acpxrc.json` (merged on top of global)

Supported keys:
```json
{
  "defaultAgent": "codex",
  "defaultPermissions": "approve-all",
  "nonInteractivePermissions": "deny",
  "authPolicy": "skip",
  "ttl": 300,
  "timeout": null,
  "format": "text",
  "agents": {
    "my-custom": { "command": "./bin/my-acp-server", "args": ["acp"] }
  },
  "auth": {
    "my_auth_method_id": "credential-value"
  }
}
```

CLI flags ALWAYS override config. (cite: docs_CLI.md line 423)

#### `flow run`

Cite: docs_CLI.md lines 71-90.

Out of scope for `@elizaos/plugin-agent-orchestrator` v0.1.0. Mentioned for completeness.

```
acpx flow run <file> [--input-json <json> | --input-file <path>] [--default-agent <name>]
```

- Runs typescript flow module step by step.
- Persists run artifacts under `~/.acpx/flows/runs/<runId>/`.
- Has its own permission requirement system (e.g. flow can require `approve-all` and acpx fails fast if not granted).

### Built-in agent command mapping (cite: docs_CLI.md lines 145-200, README.md adapter table)

| Friendly name | Wrapped command |
|---|---|
| `pi` | `npx pi-acp` |
| `openclaw` | `openclaw acp` |
| `codex` | `npx @zed-industries/codex-acp` |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` |
| `gemini` | `gemini --acp` |
| `cursor` | `cursor-agent acp` |
| `copilot` | `copilot --acp --stdio` |
| `droid` | `droid exec --output-format acp` |
| `iflow` | `iflow --experimental-acp` |
| `kilocode` | `npx -y @kilocode/cli acp` |
| `kimi` | `kimi acp` |
| `kiro` | `kiro-cli-chat acp` |
| `opencode` | `npx -y opencode-ai acp` |
| `qoder` | `qodercli --acp` |
| `qwen` | `qwen --acp` |
| `trae` | `traecli acp serve` |

For v0.1.0 of plugin-acp we validate against `codex`, `claude`, `gemini` only. Others work via the same surface but aren't part of our smoke matrix.

### Custom positional agents

Unknown agent names treated as raw commands (cite: docs_CLI.md lines 202-212):

```
acpx my-agent 'review this patch'
```

The token `my-agent` becomes the agentCommand for scoping.

### `--agent` escape hatch

Cite: docs_CLI.md lines 400-415.

```
acpx --agent ./my-custom-acp-server 'do something'
acpx --agent 'node ./scripts/acp-dev-server.mjs --mode ci' exec 'summarize'
```

Rules:
- Don't combine positional agent + `--agent` in one command.
- Resolved command becomes session scope key.
- Empty/unterminated quoting = usage error.

## 3. NDJSON event schema

When invoked with `--format json`, **acpx emits raw ACP JSON-RPC messages on stdout, one per line**. There is **no acpx-specific envelope, no synthetic `type` or `stream` fields, no key renaming** (cite: docs_CLI.md lines 482-494). This is a hard rule.

So our consumer must speak ACP JSON-RPC directly, not a synthesized acpx wrapper. Reference messages from docs_CLI.md lines 472-481:

```json
{"jsonrpc":"2.0","id":"req-1","method":"session/prompt","params":{"sessionId":"019c...","prompt":"hi"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}
{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"}}
```

### Event types we observe

These are inferred from docs + ACP spec. Full structured types in `src/services/types.ts`.

```typescript
// Base JSON-RPC message
interface JsonRpcBase {
  jsonrpc: "2.0";
}

interface JsonRpcRequest extends JsonRpcBase {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse extends JsonRpcBase {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification extends JsonRpcBase {
  method: string;
  params?: unknown;
}

// Method namespaces we'll see from ACP per docs
//
// session/* — session lifecycle and prompts
// fs/* — filesystem operations the agent requests
// terminal/* — terminal operations the agent requests (only when terminal cap enabled)
// permission/* — permission prompts to the user
// authenticate — auth handshake at session/new
//
// All `session/*` notifications carry sessionId in params.

interface SessionPromptRequest extends JsonRpcRequest {
  method: "session/prompt";
  params: {
    sessionId: string;
    prompt: string;
    // ... possibly more, adapter-specific
  };
}

interface SessionUpdateNotification extends JsonRpcNotification {
  method: "session/update";
  params: {
    sessionId: string;
    sessionUpdate:
      | "agent_message_chunk"   // streaming text from agent
      | "agent_thought_chunk"   // streaming reasoning
      | "tool_call"             // tool invocation
      | "tool_call_update"      // tool status change
      | "plan"                  // plan update
      | "diff";                 // file diff
    content?: { type: "text"; text: string } | { type: "image"; data: string };
    toolCall?: AcpToolCall;
    plan?: AcpPlan;
    diff?: AcpDiff;
  };
}

interface AcpToolCall {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  output?: string;
  // tool-specific extras
}

interface AcpPlan {
  steps: Array<{
    id: string;
    title: string;
    status: "pending" | "in_progress" | "done";
  }>;
}

interface AcpDiff {
  path: string;
  oldText?: string;
  newText?: string;
  isCreate?: boolean;
  isDelete?: boolean;
}

interface SessionPromptResponse extends JsonRpcResponse {
  // ID matches the request that prompted it
  result: {
    stopReason: "end_turn" | "max_tokens" | "cancelled" | "error" | string;
    // ... possibly more
  };
}

interface PermissionRequestRequest extends JsonRpcRequest {
  method: "permission/request";
  params: {
    sessionId: string;
    toolCallId: string;
    description: string;
    // ... more
  };
}

interface PermissionRequestResponse extends JsonRpcResponse {
  result: {
    decision: "approved" | "denied" | "cancelled";
  };
}

interface FsReadTextFileRequest extends JsonRpcRequest {
  method: "fs/read_text_file";
  params: { sessionId: string; path: string; encoding?: string };
}

interface FsWriteTextFileRequest extends JsonRpcRequest {
  method: "fs/write_text_file";
  params: { sessionId: string; path: string; content: string };
}

interface AuthenticateRequest extends JsonRpcRequest {
  method: "authenticate";
  params: { methodId: string; credentials?: Record<string, string> };
}
```

**TODO verify** the exact `sessionUpdate` discriminator values against a live `acpx --format json codex exec "hi"` capture. The above is inferred from ACP protocol convention + docs_CLI.md examples + skill doc references to "thinking, tool calls, diffs".

### Local query command output (NOT ACP stream)

`sessions list/show/history/prune` and `status` emit local JSON documents in `--format json`, NOT ACP messages (cite: docs_CLI.md lines 506-509). These are eliza-friendly query results.

```typescript
// `sessions list --format json`
type SessionsListResult = SessionRecord[];

interface SessionRecord {
  acpxRecordId: string;
  acpxSessionId?: string;
  agentSessionId?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  closed: boolean;
  closedAt?: string;        // ISO timestamp
  lastUsedAt?: string;
  createdAt: string;
  // implementation may add more
}

// `sessions show [name] --format json`
type SessionsShowResult = SessionRecord;

// `sessions history [name] --format json`
interface SessionsHistoryResult {
  entries: Array<{
    timestamp: string;
    role: "user" | "assistant" | "system";
    textPreview: string;
  }>;
}

// `status --format json`
interface StatusResult {
  status: "running" | "idle" | "dead" | "no-session";
  sessionId?: string;
  agentCommand?: string;
  pid?: number;
  uptime?: number;            // seconds
  lastPrompt?: string;        // ISO
  lastExitCode?: number;
  lastSignal?: string;
}

// `sessions prune --format json`
interface SessionsPruneResult {
  action: "prune" | "dry-run";
  dryRun: boolean;
  count: number;
  bytesFreed: number;
  pruned: string[];           // session ids
}
```

## 4. Session lifecycle

Cite: docs_CLI.md lines 416-466.

### Storage

`~/.acpx/sessions/*.json` — one file per session, persisted across acpx process exits.

### Auto-resume rules

For prompt commands (cite: docs_CLI.md lines 425-440):

1. Detect nearest git root by walking up from `absoluteCwd`.
2. If git root found, walk from `absoluteCwd` up to git root inclusive.
3. If no git root, only check exact `absoluteCwd` (no parent walk).
4. At each directory, find first active (non-closed) session matching `(agentCommand, dir, optionalName)`.
5. If found, resume.
6. If not found, exit code 4 with guidance.

If saved session pid dead: `acpx` respawns the agent, calls `session/load`, falls back to `session/new` if load fails.

### Prompt queueing (cite: docs_CLI.md lines 446-456)

When prompt already in flight:
1. A "queue owner" process owns the active turn.
2. Other `acpx` invocations enqueue prompts via local IPC.
3. Owner drains queued prompts one-by-one between turns.
4. After queue drains, owner waits up to `--ttl` seconds for new work.
5. Submitter blocks (default) or returns immediately with `--no-wait`.
6. `Ctrl+C` during turn → `session/cancel` first, brief wait for cancelled completion, then force-kill.

### Soft-close behavior (cite: docs_CLI.md lines 458-462)

- Soft-closed records: `closed: true`, `closedAt` timestamp.
- Auto-resume ignores closed sessions.
- Closed sessions can be resumed explicitly via record id.
- Records keep turn history previews used by `sessions history`.

### Named sessions

`-s, --session <name>` adds `name` to scope key. Multiple parallel conversations in same repo + agent.

### CWD scoping

`--cwd` sets starting point for directory-walk routing (bounded by git root) and exact scope dir when creating sessions via `sessions new`.

## 5. Permission model

Cite: docs_CLI.md lines 540-562.

Three modes (mutex):

| Mode | Behavior |
|---|---|
| `--approve-all` | Auto-approve everything. |
| `--approve-reads` (default) | Auto-approve read/search; prompt for others (TTY). |
| `--deny-all` | Auto-deny when possible. |

Non-interactive policy:
- `--non-interactive-permissions deny` (default): deny non-read/search prompts when no TTY.
- `--non-interactive-permissions fail`: fail with `PERMISSION_PROMPT_UNAVAILABLE` instead.

For `@elizaos/plugin-agent-orchestrator`, the plugin runs in a server context with no TTY. Strategy:
- `approvalPreset = "autonomous"` → `--approve-all` (most common case for milady cloud).
- `approvalPreset = "permissive"` → `--approve-all`.
- `approvalPreset = "standard"` → `--approve-reads --non-interactive-permissions deny`.
- `approvalPreset = "readonly"` → `--deny-all`.

## 6. Auth

Cite: docs_CLI.md lines 425-431.

For ACP `authenticate` handshakes:
- Either populate `config.auth.<method_id>` in `~/.acpx/config.json`.
- Or set `ACPX_AUTH_<METHOD_ID>` environment variables (e.g. `ACPX_AUTH_OPENAI_API_KEY`).

Ambient provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc) are still passed through to child agents but do **NOT** trigger ACP auth-method selection on their own.

For our service:
- We pass agent credentials via env-forwarding to the spawned acpx subprocess.
- We translate `agentCredentials` (eliza-style) into `ACPX_AUTH_*` env vars or write to config — TBD by W4.

### Per-agent auth notes

- **codex**: Subscription-backed (ChatGPT Pro/Plus/Business/Enterprise) via `codex login` (writes `~/.codex/auth.json`). Or API key via `OPENAI_API_KEY`. acpx auth method id likely `OPENAI_API_KEY` or `CODEX_AUTH`. **TODO verify**.
- **claude**: Subscription via `claude login` or `ANTHROPIC_API_KEY`. **TODO verify** auth method id.
- **gemini**: API key only via `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY`. **TODO verify** auth method id.

## 7. Cancel semantics

Cite: docs_CLI.md lines 264-278, lines 446-456.

- `acpx <agent> cancel` sends ACP `session/cancel` via queue-owner IPC.
- If no prompt running, prints "nothing to cancel" and exits 0.
- During an in-flight turn, user `Ctrl+C` triggers `session/cancel` first, then force-kill if needed.
- `stopReason` from completed session/prompt response indicates resolution:
  - `"end_turn"` — agent finished naturally.
  - `"max_tokens"` — hit token cap.
  - `"cancelled"` — explicit cancel.
  - `"error"` — agent error.
  - other — adapter-specific.

For `cancelSession()` in our service: invoke `acpx <agent> cancel -s <name>` against the running queue owner. The pending prompt's `session/prompt` response will return with `stopReason: "cancelled"`.

## 8. Error modes

### Exit codes (cite: docs_CLI.md lines 564-572)

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Agent/protocol/runtime error |
| `2` | CLI usage error |
| `3` | Timeout |
| `4` | No session found (prompt requires explicit `sessions new`) |
| `5` | Permission denied |
| `130` | Interrupted (SIGINT/SIGTERM) |

### Plugin-acp error mapping

| Symptom | Cause | Plugin recommendation |
|---|---|---|
| `acpx` binary not found (`ENOENT`) | Not installed or `ELIZA_ACP_CLI` misconfigured | Surface clear error: "ACP CLI not found at `${binPath}`. Set ELIZA_ACP_CLI or `npm install -g acpx@latest`." Don't retry. |
| Exit code 4 with stderr "no session found" | Prompt issued without prior `sessions new` | Bug in our code — should never happen if we always call `sessions new` first. Log with full stack and surface as internal error. |
| Exit code 5 (permission denied) | One or more permission requests rejected | Surface to caller with details. Don't retry automatically. |
| Exit code 3 (timeout) | `--timeout` exceeded waiting for response | Mark session status `errored`, emit error event. Caller retries by spawning fresh session. |
| Exit code 2 (usage error) | Bug in our CLI invocation | Log full command + stderr. Internal error, don't retry. |
| Exit code 1 with stderr containing auth keywords (`authenticate`, `unauthorized`, `401`) | Auth handshake failed | Surface auth error with method id (if extractable). Don't retry without intervention. |
| Exit code 1 with stderr containing protocol keywords (`Invalid params`, `method not found`) | Adapter doesn't support the method we called | Log clearly, mark unsupported feature, fall back if possible (e.g. if `set_model` not supported, ignore the model option). |
| Exit code 130 (SIGINT) | acpx received interrupt | If caller didn't request cancel, this is a process-tree-kill. Mark session stopped. |
| stdout closes unexpectedly mid-prompt (broken pipe) | Process crashed during NDJSON streaming | Mark session errored, emit error event with last buffered partial line for diagnostics. |
| Empty NDJSON stream (process exits 0 with no output) | Quiet adapter or empty prompt | Mark session completed with empty `finalText`. |
| `--json-strict` with --format text combo | Usage error | Plugin should never emit this combo. |
| `--no-terminal` warns about adapter compatibility | Some adapters require terminal cap | Plugin sets `--no-terminal` always (server context); accept warning, don't escalate. |

## 9. Crash reconnect

Cite: docs_CLI.md lines 442-444.

- `acpx` periodically checks saved session pid via `kill(pid, 0)` semantics.
- If pid dead on next prompt: respawn agent, attempt `session/load`, fall back to `session/new` if load fails.
- Plugin behavior: rely on this transparency. If our service detects a session was assumed alive but the next acpx invocation creates a fresh one (we can detect this by comparing acpxSessionId pre/post), we update SessionStore accordingly and emit a `reconnected` lifecycle event.
- Edge case: if session/load partially restores but session-prompt is mid-turn, the agent may emit a stale tool_call_update. Plugin should ignore tool_call_update events whose toolCall.id we don't recognize.

## 10. Per-agent notes

### codex

- Adapter command: `npx @zed-industries/codex-acp`.
- Authoritative mode: codex CLI subscription via `codex login` writes `~/.codex/auth.json`.
- API key fallback: `OPENAI_API_KEY` env or `ACPX_AUTH_OPENAI_API_KEY`.
- Models: GPT-4, GPT-5, etc. Set via `--model <id>` or per-session `set model <id>`.
- Known quirks: codex has interactive update prompts ("update available, hit y to update") and trust prompts ("do you trust this directory") that plugin-agent-orchestrator's PTY layer dismissed via key-press injection. ACPX bypasses these — codex-acp adapter handles them differently or doesn't surface them.
- **TODO verify** auth method id.

### claude

- Adapter: `npx -y @agentclientprotocol/claude-agent-acp`.
- Auth: `claude login` (subscription via Anthropic) or `ANTHROPIC_API_KEY`.
- Models: claude-3.5-sonnet, claude-opus-4, etc. Adapter may consume session creation metadata for model selection.
- **TODO verify** auth method id and model selection mechanism.

### gemini

- Adapter command: `gemini --acp` (native gemini-cli).
- Auth: `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` (no subscription path).
- Models: gemini-2.0-flash, gemini-2.5-pro, etc.
- **TODO verify** auth method id.

## 11. Subprocess spawning recommendations (W4)

### Process management

Use Node `child_process.spawn` (NOT `exec` or `execFile`):

```typescript
import { spawn } from "node:child_process";

const proc = spawn(ELIZA_ACP_CLI, [
  "--format", "json",
  "--cwd", workdir,
  "--approve-all",  // map from approvalPreset
  ...(timeoutSec ? ["--timeout", String(timeoutSec)] : []),
  agentType,        // codex | claude | gemini
  "exec",           // or use `prompt` after `sessions new`
  task,
], {
  env: {
    ...process.env,
    ...(model ? { OPENAI_MODEL: model } : {}),  // adapter-specific env
    ...customEnv,
  },
  cwd: workdir,
  stdio: ["pipe", "pipe", "pipe"],
  // Detached: false. We want to be in the same process group so SIGTERM cascades.
});
```

### NDJSON line buffering

Stdout arrives in arbitrary chunks. Maintain a partial-line accumulator:

```typescript
let buffer = "";
proc.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line);
      handleAcpEvent(event);
    } catch (err) {
      // Malformed JSON — log and continue. Don't crash the stream.
      logger.warn(`[acp] malformed NDJSON line, ignoring: ${line.slice(0, 200)}`);
    }
  }
});
proc.on("close", () => {
  // flush trailing partial if any
  if (buffer.trim()) {
    try { handleAcpEvent(JSON.parse(buffer.trim())); } catch {}
  }
});
```

### Stderr capture

Capture stderr for diagnostics. Don't fail the stream on stderr lines — many adapters print warnings to stderr legitimately. Buffer up to a reasonable cap (e.g. 64KB) for inclusion in error events.

### Backpressure

Stdout NDJSON is typically small. If we expect large diffs, watch `proc.stdout.readable` flow control. Don't block indefinitely on processing; spool events into a queue and drain async.

### Process tree management

When killing a session:

1. Send `SIGTERM` to `proc` (acpx will forward `session/cancel` if it can).
2. Wait up to 5 seconds for graceful exit.
3. If still alive, `SIGKILL`.

Process group: spawn with default settings (not detached). On Linux, `SIGTERM` to the parent reaches children unless they explicitly detach. acpx itself is well-behaved.

### Environment forwarding

Carry these from `process.env` into the subprocess:
- All `ACPX_AUTH_*` (we may set these per-spawn)
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL` (if set)
- `PATH`, `HOME`, `USER`, locale vars
- ELIZA_*, MILADY_* (so child agents can read runtime context if they care)

Strip these from forwarding (security):
- `DISCORD_API_TOKEN`, `TELEGRAM_BOT_TOKEN`, etc — agent shouldn't have direct connector creds.
- `MILADY_VAULT_PASSPHRASE` — vault is parent-process-only.

### Security: never log stdin contents

Tasks may contain prompts with sensitive info. Log only metadata (agentType, sessionId, length, first 80 chars). NEVER log full task text in error paths.

### Logging strategy

Suggested levels:
- `trace`: every NDJSON event seen.
- `debug`: spawn options, exit codes, session lifecycle transitions.
- `info`: session created, completed, errored.
- `warn`: malformed events, auth issues, retries.
- `error`: spawn failed, unrecoverable session error.

Pipe through eliza's `runtime.logger` so logs land in standard channels.

## 12. Versioning

- Target: `acpx@latest` at time of plugin v0.1.0 release.
- ACPX is **alpha**. The repo's main README explicitly states: "CLI/runtime interfaces are likely to change. Anything you build downstream of this might break until it stabilizes."
- ACP protocol itself is more stable (zed-industries reference impl).
- Plugin response: pin to a specific minor at install time (e.g. `acpx@^0.5.0`) and document the tested version in package.json `peerDependenciesMeta` or similar.
- ACP coverage roadmap (cite: docs_2026-02-19-acp-coverage-roadmap.md) tracks which methods are currently honored vs missing across adapters.

### Stability promise

What's likely to change before 1.0:
- Specific NDJSON event shapes (e.g. the `sessionUpdate` discriminator string set).
- Permission flag names.
- Config file schema.

What's likely stable:
- ACP JSON-RPC method names and shapes (`session/prompt`, `session/cancel`, `session/load`, etc).
- The fact that `--format json` emits raw ACP JSON-RPC.
- Exit code values (`0`, `1`, `2`, `3`, `4`, `5`, `130`).
- Session storage location (`~/.acpx/sessions/`).

Plugin should degrade gracefully if specific event types are missing. Always include a generic fallback handler for unknown `sessionUpdate` discriminators.

## 13. Plugin invocation patterns (cookbook)

For W4 to follow.

### Spawn a session and run one task

```typescript
async function spawnAndRunOnce(opts: SpawnOptions, task: string): Promise<PromptResult> {
  // Use exec for one-shot — no session persisted
  const args = [
    "--format", "json",
    "--cwd", opts.workdir,
    approvalFlag(opts.approvalPreset),  // --approve-all etc
    ...timeoutFlags(opts.timeoutMs),
    opts.agentType,
    "exec",
    task,
  ];
  return spawnAcpxAndCollect(args, opts.env);
}
```

### Spawn persistent session

```typescript
async function spawnSession(opts: SpawnOptions): Promise<SpawnResult> {
  const sessionName = opts.name ?? randomUUID();
  // 1. Create session
  await runAcpxJson([
    "--format", "json",
    "--cwd", opts.workdir,
    opts.agentType,
    "sessions", "new",
    "--name", sessionName,
  ]);
  // 2. Verify it landed
  const show = await runAcpxJson([
    "--format", "json",
    "--cwd", opts.workdir,
    opts.agentType,
    "sessions", "show", sessionName,
  ]);
  return {
    sessionId: ourLocalId(),
    acpxRecordId: show.acpxRecordId,
    acpxSessionId: show.acpxSessionId,
    agentSessionId: show.agentSessionId,
    pid: show.pid ?? -1,
    authReady: true,
  };
}
```

### Send prompt to existing session

```typescript
async function sendPrompt(sessionId: string, text: string, opts?: SendOptions): Promise<PromptResult> {
  const session = await store.get(sessionId);
  const args = [
    "--format", "json",
    "--cwd", session.workdir,
    approvalFlag(session.approvalPreset),
    ...(opts?.timeoutMs ? ["--timeout", String(opts.timeoutMs / 1000)] : []),
    session.agentType,
    "prompt",
    "-s", session.name ?? sessionRecordToName(session),
    text,
  ];
  return spawnAcpxAndCollect(args);
}
```

### Cancel session

```typescript
async function cancelSession(sessionId: string): Promise<void> {
  const session = await store.get(sessionId);
  await runAcpxOnce([
    session.agentType,
    "cancel",
    "-s", session.name ?? sessionRecordToName(session),
  ]);
}
```

### Soft-close

```typescript
async function closeSession(sessionId: string): Promise<void> {
  const session = await store.get(sessionId);
  await runAcpxOnce([
    session.agentType,
    "sessions", "close",
    session.name ?? sessionRecordToName(session),
  ]);
  await store.updateStatus(sessionId, "stopped");
}
```

### Reattach after crash

```typescript
async function reattachSession(sessionId: string): Promise<SpawnResult> {
  const session = await store.get(sessionId);
  // Just send a probe prompt; acpx auto-reattaches via session/load
  const result = await sendPrompt(sessionId, "(probe)", { silent: true });
  // Verify auth and update status
  await store.updateStatus(sessionId, "ready");
  return { ... };
}
```

## 14. Open verification items

These all need a real-world test once acpx is installed. Mark as resolved in the doc when verified.

- [ ] `**TODO verify**` exact NDJSON event flow for `acpx codex exec "hi"` — what does the stream look like end-to-end?
- [ ] `**TODO verify**` whether `acpx --format json sessions new` returns JSON or just succeeds silently.
- [ ] `**TODO verify**` whether `--timeout` value is passed to ACP method or only enforced at the acpx process level.
- [ ] `**TODO verify**` exact `ACPX_AUTH_*` method ids per agent (codex, claude, gemini).
- [ ] `**TODO verify**` whether `acpx codex prompt --no-wait` returns immediately with a queue ack JSON or just exit 0.
- [ ] `**TODO verify**` if the session/cancel response actually arrives via stdout NDJSON before process exit, or if we just observe exit code.
- [ ] `**TODO verify**` if `session/load` failure (when respawning a dead pid) emits a JSON event we can intercept, or just falls through to `session/new` silently.

W4 should run these tests during implementation and amend this doc.

---

**Citations**:
- `.research/acpx-docs/README.md` (full file, esp adapter table)
- `.research/acpx-docs/docs_CLI.md` (lines 1-603, every section cited above)
- `.research/acpx-docs/skills_acpx_SKILL.md` (full file, supplementary patterns)
- `.research/acpx-docs/docs_2026-02-19-acp-coverage-roadmap.md` (full file, ACP method coverage)
