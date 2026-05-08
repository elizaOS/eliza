# @elizaos/plugin-agent-orchestrator

ElizaOS plugin: acpx-backed task and subagent backend (wraps the `acpx` CLI to spawn coding agents). Sibling, not replacement, for `@elizaos/plugin-agent-orchestrator`. Distinct from `@elizaos/plugin-acp` (Shaw's ACP gateway client).

Drop-in compatible with `@elizaos/plugin-agent-orchestrator` (PTY-based). Uses
ACPX (Agent Client Protocol CLI) under the hood for structured streaming,
named sessions, cooperative cancel, and crash-resilient sessions.

## Why this exists

`plugin-agent-orchestrator` (sibling, PTY-based) maintains an entire
stall-classifier, ANSI-stripping, prompt-regex-dismissal, pty-state-capture
stack to extract structure out of terminal byte streams. The Agent Client Protocol (ACP) is the structured
protocol underneath, `tool_call`, `thinking`, `diff`, `done` events, typed
auth handshake, cooperative `session/cancel`. ACPX provides one CLI surface
across 15 Agent Client Protocol (ACP)-compatible coding agents (codex, claude-code, gemini, copilot,
cursor, droid, qwen, etc).

This plugin is a sibling-not-replacement: deploys alongside
`plugin-agent-orchestrator`, exposes the same action names so users can switch
transports by swapping the plugin import.

## Goals

- Drop-in action surface compatible with `plugin-agent-orchestrator`
- ACPX subprocess transport (NDJSON streaming, no pty)
- Configurable cli binary (`ELIZA_ACP_CLI=acpx`, override possible)
- Persistent named sessions (eliza-runtime-table-backed)
- Cooperative cancel + crash reconnect
- 80%+ unit test coverage
- Parity smoke vs plugin-agent-orchestrator on at least codex
- Publishable to npm under `@elizaos`

## Non-goals

- Replace plugin-agent-orchestrator (sibling, not replacement)
- Git workspace provisioning (PROVISION_WORKSPACE / FINALIZE_WORKSPACE)
- Frontend xterm view
- Non-codex agent support in v0.1.0 (codex first; claude/gemini in 0.2.0+)

## Action surface

Match `plugin-agent-orchestrator` exactly:

| Action | Purpose |
|---|---|
| `SPAWN_AGENT` | Spawn an acpx coding-agent session |
| `SEND_TO_AGENT` | Send prompt or input to running session |
| `LIST_AGENTS` | List active sessions |
| `STOP_AGENT` | Terminate session via session/cancel |
| `CREATE_TASK` | Async task (spawn + first prompt + return when done) |
| `CANCEL_TASK` | Cooperative cancel |

## Provider

`availableAgents` provider exposes which Agent Client Protocol (ACP)-compatible agents are installed.

## Architecture

```
┌─────────────────────────┐
│ Eliza runtime           │
│  ├─ actions (SPAWN, ..) │
│  └─ provider (available)│
└──────────┬──────────────┘
           │
┌──────────v──────────────┐
│ AcpxSubprocessService   │
│  - spawn `acpx` proc    │
│  - parse NDJSON stream  │
│  - emit typed events    │
│  - cancel via session/  │
└──────────┬──────────────┘
           │
┌──────────v──────────────┐
│ acpx (cli subprocess)   │
│  --format json          │
│  codex / claude / etc   │
└─────────────────────────┘
```

## Reference materials

In `.research/`:
- `plugin-agent-orchestrator-src/`, full source of the PTY plugin we're paralleling
- `plugin-agent-orchestrator-package.json`, its deps
- `plugin-agent-orchestrator-README.md`, its surface
- `acpx-docs/README.md`, acpx README
- `acpx-docs/docs_CLI.md`, full acpx CLI reference
- `acpx-docs/skills_acpx_SKILL.md`, skill reference
- `nyx-spawn-codex/spawn_codex.js`, example of how nyx wraps plugin-agent-orchestrator's CREATE_TASK today

## Layout

```
src/
  index.ts              # plugin export
  actions/
    spawn-agent.ts
    send-to-agent.ts
    list-agents.ts
    stop-agent.ts
    create-task.ts
    cancel-task.ts
  providers/
    available-agents.ts
  services/
    acpx-subprocess.ts  # core ACPX wrapper
    session-store.ts    # persistent session state
    types.ts            # acpx event types
  __tests__/
    *.test.ts
docs/
  ACPX_REFERENCE.md     # W2 output
  PARITY_SPEC.md        # W3 output
PROJECT.md              # this file
```

## Status

🚧 Bootstrapping, wave A in progress.

## License

MIT
