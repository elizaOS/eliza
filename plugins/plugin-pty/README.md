# @elizaos/plugin-pty

Registers `PTY_SERVICE` so the elizaOS app's web terminal can drive a **real
interactive CLI** — the interactive `eliza-code` CLI running on Eliza
Cloud/cerebras (a slash-command TUI we own, no TOS exposure).

The xterm UI, the WebSocket keystroke path, and the CLI already exist; without a
registered `PTY_SERVICE` the terminal's console bridge is `null` and it's inert.
This plugin is that missing keystone.

- **Opt-in** — add `@elizaos/plugin-pty` to an agent's plugin list (no
  `autoEnable`; dormant otherwise). Disabled on store builds.
- **Terminal-token gated** — remote HTTP callers must provide
  `ELIZA_TERMINAL_RUN_TOKEN` as `X-Eliza-Terminal-Token` or `terminalToken`;
  generic API auth alone cannot spawn, list, or stop PTY sessions. Trusted
  loopback cockpit traffic is allowed server-side without exposing that token to
  browser JavaScript.
- **Runtime-aware engine** — Bun native truePty under Bun (node-pty's write path
  is broken there), `@lydell/node-pty` under Node.
- **Routes** — `POST /api/pty/sessions` (spawn), `GET /api/pty/sessions` (list),
  `DELETE /api/pty/sessions/:id` (stop).
- **Minimal child env** — PTY processes get only safe terminal/runtime env plus
  explicit eliza-code settings, not the full server `process.env`.
- **Dedicated cloud credential** — eliza-code receives only
  `PTY_ELIZA_CLOUD_API_KEY` or a caller-supplied per-session key, never the
  agent server's primary `OPENAI_API_KEY`.
- **Coding-only REPL** — cockpit sessions pass `--coding-only` so the terminal
  cannot recursively spawn orchestrator sub-agents.
- **Experimental vendor-CLI tier** — `kind: "claude" | "codex"` spawns the real
  interactive Claude Code / Codex CLI on the user's own subscription
  credentials. Off by default: requires `PTY_VENDOR_CLI_ENABLED=true` (a
  separate gate from `PTY_INTERACTIVE_ENABLED`); store builds always reject.

See [CLAUDE.md](./CLAUDE.md) for architecture, the cerebras wiring, config, and
the evidence standard.
