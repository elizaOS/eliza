# @elizaos/plugin-pty

Registers `PTY_SERVICE` so the elizaOS app's web terminal can drive a **real
interactive CLI** — the interactive `eliza-code` CLI running on Eliza
Cloud/cerebras (a slash-command TUI we own, no TOS exposure).

The xterm UI, the WebSocket keystroke path, and the CLI already exist; without a
registered `PTY_SERVICE` the terminal's console bridge is `null` and it's inert.
This plugin is that missing keystone.

- **Opt-in** — add `@elizaos/plugin-pty` to an agent's plugin list (no
  `autoEnable`; dormant otherwise). Disabled on store builds.
- **Runtime-aware engine** — Bun native truePty under Bun (node-pty's write path
  is broken there), `@lydell/node-pty` under Node.
- **Routes** — `POST /api/pty/sessions` (spawn), `GET /api/pty/sessions` (list),
  `DELETE /api/pty/sessions/:id` (stop).

See [CLAUDE.md](./CLAUDE.md) for architecture, the cerebras wiring, config, and
the evidence standard.
