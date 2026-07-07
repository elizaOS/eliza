# Terminal TUI run mode

The agent ships an interactive **terminal UI** (TUI): a full-screen shell that
lists every registered terminal view, mounts them inline, and keeps a chat
composer pinned to the bottom rows. It is implemented in
`src/tui/agent-terminal-tui.ts` and rendered with `@elizaos/tui`.

This document is the contract for the run mode: how to start it, the transport
it speaks, the security boundary it lives inside, and how a plugin view reaches
the screen.

## There is no SSH server

The TUI talks to an **already-running backend over loopback HTTP**. It is not an
SSH server and the agent does not embed one. Earlier code named the conversation
`"SSH terminal"` and a test typed `"hello over ssh"`; that naming was aspirational
— no `sshd` exists in the agent or the elizaOS Linux image. The conversation is
now created as `"elizaOS terminal"` with `metadata.source = "terminal-tui"`,
which reflects the actual mechanism.

To reach the terminal from another machine, **SSH into the host the normal way
and run the TUI locally on the box** (loopback stays valid, no proxy header). For
hosted/remote cases use the cloud container control-plane
(`packages/cloud/api/src/stubs/ssh2.ts` + the Node sidecar), which is a separate
system from this in-process TUI.

## Subcommands

The `eliza-autonomous` binary (`src/cli/index.ts`) exposes two TUI commands:

| Command | What it does |
| --- | --- |
| `eliza-autonomous tui` | Start the interactive terminal TUI against an already-running backend. Requires a TTY. |
| `eliza-autonomous tui-smoke [--api <url>]` | Boot the TUI once against a backend, print the readiness marker `elizaos-tui-ready api=<url>`, and exit. Used as a boot smoke check (no TTY required). |

Both resolve the backend URL from `--api`, then `ELIZA_AGENT_URL`, then
`ELIZA_API_URL`, falling back to the default loopback API base
(`resolveDefaultApiBaseUrl()` in `agent-terminal-tui.ts`).

The in-process TUI (started from `serve`/`start` when a terminal is attached)
is gated by `isTerminalTuiEnabled()` (`src/tui/tui-enabled.ts`):

- `ELIZA_TERMINAL_TUI` = `1`/`true`/`on` forces it on; `0`/`false`/`off` forces
  it off.
- Otherwise it auto-enables only when **both** `stdin` and `stdout` are TTYs and
  the process is not running under `CI`/`NODE_ENV=test`.

## Transport, auth, and the loopback trust boundary

The TUI client (`readJson` in `agent-terminal-tui.ts`) always sends
`Content-Type: application/json`. When `ELIZA_API_TOKEN` is set in the TUI
process, it also sends `Authorization: Bearer <ELIZA_API_TOKEN>`, which is the
same token key the backend's `isAuthorized` path validates.

Without `ELIZA_API_TOKEN`, local sessions work because the client hits
`127.0.0.1`, which the backend treats as trusted via `isTrustedLocalRequest`.

That trust gate is **disabled when `X-Forwarded-For` is present** (see
`src/api/server-helpers-auth-trust.test.ts`) — i.e. through any reverse proxy or
tunnel. The default API bind host is also `127.0.0.1`
(`packages/shared/src/runtime-env.ts`). Together these mean the TUI is
**loopback-only by construction**:

- It is safe to run on the same host as the backend with no auth.
- It can work through a proxy/tunnel only when the TUI process has
  `ELIZA_API_TOKEN` set to a token accepted by the backend.
- It will **not** work end-to-end through a proxy/tunnel with no token when that
  proxy injects `X-Forwarded-For`, because the loopback trust the client depends
  on is dropped there.

Do **not** rely on the `X-Forwarded-For`-fragile loopback gate for remote access,
and do **not** add an `sshd` to the agent.

## How a registered terminal view reaches the screen

> **Shipped inventory note (#15269):** no plugin currently ships a TUI view —
> the shipped plugin view inventory is GUI-only. The registration pipeline
> below is retained as the compatibility contract for deliberately
> reintroducing terminal views later; with an empty registry the shell lists
> no plugin views and `GET /api/views?viewType=tui` returns an empty inventory
> (a designed empty result, not an error).

1. A plugin authors one spatial view and registers it for the terminal with
   `registerSpatialTerminalView(id, () => <View … />)`
   (`@elizaos/ui/spatial/tui`), which adapts the React tree to an `@elizaos/tui`
   `Component` and stores it in the process-global terminal-view registry
   (`packages/tui/src/view-registry.ts`, keyed by `Symbol.for`).
2. The backend advertises the view under `GET /api/views?viewType=tui`.
3. The TUI lists every `viewType: "tui"` view; ids with a registered component
   are flagged renderable (`hasTerminalView(id)`).
4. Opening a view mounts it inline. The host builds it from the registered
   factory (`getTerminalViewFactory(id)`) so it can supply `onActivate`; a
   focused control's activation `POST`s `/api/views/:id/activate?viewType=tui`.
   Navigating a view `POST`s `/api/views/:id/navigate?viewType=tui` so the
   runtime marks it active.

`listTerminalViewIds()` enumerates every registered view — the iteration target
for per-view terminal coverage.
