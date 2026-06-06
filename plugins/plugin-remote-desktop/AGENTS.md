# @elizaos/plugin-remote-desktop

Owner-only remote desktop session control for Eliza agents.

## Purpose / role

Lets the owner connect to the agent's host machine from another device (typically a phone) over Tailscale VNC, Tailscale SSH, or an ngrok TCP tunnel, gated by an explicit confirmation step and (in cloud mode) a 6-digit pairing code. The plugin is opt-in — add it to the agent's plugin list.

This plugin was extracted from `@elizaos/plugin-personal-assistant` as part of the LifeOps decomposition. The action metadata and types are in place and the package compiles standalone, but the handler body is currently a **stub** that returns `NOT_IMPLEMENTED_MIGRATION_PENDING`. The real implementation still lives in plugin-lifeops and will be ported in the next migration pass.

## Plugin surface

**Action**
- `REMOTE_DESKTOP` (`src/actions/remote-desktop.ts`) — umbrella action with op-based dispatch (`start` / `status` / `end` / `list` / `revoke`). Role gate: `OWNER`. Contexts: `browser`, `automation`, `settings`, `admin`, `terminal`. Sets `suppressPostActionContinuation: true` so the planner does not chain a follow-up turn after a session is opened.

No providers. No services. No schema. Session state is owned by the underlying `RemoteSessionService` (currently still in `@elizaos/plugin-personal-assistant`); it is in-memory plus a JSON file under `resolveStateDir()`.

## Layout

```
src/
  index.ts                       Plugin export; re-exports action + types
  plugin.ts                      Plugin object (actions: [remoteDesktopAction])
  types.ts                       Shared types (RemoteDesktopSession, RemoteSession, ...)
  actions/
    remote-desktop.ts            REMOTE_DESKTOP umbrella action (handler stubbed pending migration)
  lifeops/                       Reserved for migrated remote-desktop.ts (backend detection + in-process session store)
  remote/                        Reserved for migrated remote-session-service.ts + pairing-code.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-remote-desktop build        # bun build → dist/ (ESM) + tsc --emitDeclarationOnly
bun run --cwd plugins/plugin-remote-desktop dev          # hot-rebuild via build.ts
bun run --cwd plugins/plugin-remote-desktop test         # vitest run
bun run --cwd plugins/plugin-remote-desktop typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-remote-desktop check        # typecheck + test
bun run --cwd plugins/plugin-remote-desktop clean        # rm -rf dist .turbo
```

## Config / env vars

| Variable | Where used | Required |
|---|---|---|
| `ELIZA_REMOTE_LOCAL_MODE` | `RemoteSessionService.startSession` — `1` skips pairing-code requirement | No |
| `ELIZA_REMOTE_ACCESS_TOKEN` | External client attach token | No |
| `ELIZA_TAILSCALE_NODE` | Override Tailscale hostname for VNC/SSH URLs | No |
| `ELIZA_NGROK_AUTH_TOKEN` | ngrok auth token (passed via env, never argv) | No |
| `ELIZA_TEST_REMOTE_DESKTOP_BACKEND` | Force mock mode for tests | No |

All variables are read by the underlying helpers that still live in `@elizaos/plugin-personal-assistant` until the migration pass moves them here.

## Migration mapping (LifeOps decomposition)

| New location (this plugin) | Source in `@elizaos/plugin-personal-assistant` |
|---|---|
| `src/actions/remote-desktop.ts` | `plugins/plugin-personal-assistant/src/actions/remote-desktop.ts` |
| `src/lifeops/remote-desktop.ts` (TODO) | `plugins/plugin-personal-assistant/src/lifeops/remote-desktop.ts` |
| `src/remote/remote-session-service.ts` (TODO) | `plugins/plugin-personal-assistant/src/remote/remote-session-service.ts` |
| `src/remote/pairing-code.ts` (TODO) | `plugins/plugin-personal-assistant/src/remote/pairing-code.ts` |
| `src/types.ts` (already extracted) | inline in `lifeops/remote-desktop.ts` + `remote/remote-session-service.ts` |

## How to extend

**Add a new subaction to REMOTE_DESKTOP:**
1. Add the name to `RemoteDesktopSubaction` in `src/types.ts`.
2. After the migration: add an entry to the `SUBACTIONS` map in `src/actions/remote-desktop.ts`, write a `handle<Op>` function, add a case to the dispatch switch.
3. Extend the `parameters` array on `remoteDesktopAction` if the op needs new params.

**Add a new backend:**
1. After the migration: add the backend tag to `RemoteDesktopBackend` in `src/types.ts`.
2. Add a `probe<Backend>` and `start<Backend>Session` helper in `src/lifeops/remote-desktop.ts`.
3. Extend `detectRemoteDesktopBackend` and `backendAvailable` to cover the new backend.

## Conventions / gotchas

- **OWNER role gate.** `REMOTE_DESKTOP` will not fire for non-owner entities. Check the runtime's role system if the action is unexpectedly unavailable.
- **`confirmed: true` is mandatory for `start`.** `RemoteSessionService.startSession` throws `RemoteSessionError("NOT_CONFIRMED")` otherwise. The action uses `requireConfirmation` from `@elizaos/core` to surface a confirmation prompt to the owner.
- **Pairing codes are one-time.** Each `issuePairingCode()` call rotates the code; `consume()` is single-use.
- **`suppressPostActionContinuation: true`** — opening a remote session is consumed out-of-band (a VNC viewer / SSH client), so the planner should not chain another turn.
- **Handler is currently a stub.** Until the migration pass lands, the action returns `success: false` with `error: "NOT_IMPLEMENTED_MIGRATION_PENDING"` and points callers back to `plugin-lifeops`.
- **No business computation in this plugin's surface.** Session state and ingress URL come from the underlying service; the action just shapes the `ActionResult` for the agent.
- **No `console.*` in server code.** Use `@elizaos/core`'s `logger` once the helpers are migrated; prefix with `[remote-desktop]` and attach context objects on errors.
- See root `AGENTS.md` for repo-wide architecture commandments, logger conventions, ESM rules, and naming.
