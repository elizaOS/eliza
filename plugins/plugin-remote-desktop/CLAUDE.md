# @elizaos/plugin-remote-desktop

Owner-only remote desktop session control for Eliza agents.

## Purpose / role

Lets the owner connect to the agent's host machine from another device (typically a phone) over Tailscale VNC, Tailscale SSH, or an ngrok TCP tunnel, gated by an explicit confirmation step and (in cloud mode) a 6-digit pairing code. The plugin is opt-in — add it to the agent's plugin list.

This plugin was extracted from `@elizaos/plugin-personal-assistant` as part of the LifeOps decomposition. It owns the full remote-desktop implementation: the `REMOTE_DESKTOP` action, the backend-detection engine, and the in-process `RemoteSessionService` control plane. PA re-exports `remoteDesktopAction` + `detectRemoteDesktopBackend` via a thin shim for back-compat and loads this plugin at init (`ensureLifeOpsRemoteDesktopPluginRegistered`). Exactly one plugin registers `REMOTE_DESKTOP` — this one.

## Plugin surface

**Action**
- `REMOTE_DESKTOP` (`src/actions/remote-desktop.ts`) — umbrella action with op-based dispatch (`start` / `status` / `end` / `list` / `revoke`). Role gate: `OWNER`. Contexts: `browser`, `automation`, `settings`, `admin`, `terminal`. Sets `suppressPostActionContinuation: true` so the planner does not chain a follow-up turn after a session is opened. `start` is gated by `requireConfirmation` (LLM-supplied `confirmed:true` is never authoritative — the first turn always asks the owner).

No providers. No services. No schema. Session state is owned by the in-process `RemoteSessionService` (`src/remote/`); it is in-memory plus a JSON file under `resolveStateDir()/lifeops/remote-sessions.json`.

## Layout

```
src/
  index.ts                       Plugin export; re-exports action + engine + service + types
  plugin.ts                      Plugin object (actions: [remoteDesktopAction])
  types.ts                       Canonical types (RemoteDesktopSession, RemoteSession, ...)
  actions/
    remote-desktop.ts            REMOTE_DESKTOP umbrella action (real handler; resolveActionArgs dispatch)
  lifeops/
    remote-desktop.ts            Backend detection (Tailscale/ngrok/VNC) + in-process session store
  remote/
    remote-session-service.ts    Control-plane service (lifecycle, pairing-code gate, data-plane handoff)
    pairing-code.ts              6-digit rolling one-time pairing codes
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
| `ELIZA_STATE_DIR` | `resolveStateDir()` — overrides the default base directory for `lifeops/remote-sessions.json` | No |
| `ELIZA_TEST_REMOTE_DESKTOP_BACKEND` | Force mock mode for tests | No |

All variables are read by this plugin's engine (`src/lifeops/remote-desktop.ts`) and control-plane service (`src/remote/remote-session-service.ts`).

## Migration mapping (LifeOps decomposition — complete)

The remote-desktop domain moved here from `@elizaos/plugin-personal-assistant`. PA now keeps only a thin re-export shim at `src/actions/remote-desktop.ts`.

| Location (this plugin) | Former source in `@elizaos/plugin-personal-assistant` |
|---|---|
| `src/actions/remote-desktop.ts` | `src/actions/remote-desktop.ts` |
| `src/lifeops/remote-desktop.ts` | `src/lifeops/remote-desktop.ts` |
| `src/remote/remote-session-service.ts` | `src/remote/remote-session-service.ts` |
| `src/remote/pairing-code.ts` | `src/remote/pairing-code.ts` |
| `src/types.ts` | inline in the engine + service (now canonical here) |

## How to extend

**Add a new subaction to REMOTE_DESKTOP:**
1. Add the name to `RemoteDesktopSubaction` in `src/types.ts`.
2. Add an entry to the `SUBACTIONS` map in `src/actions/remote-desktop.ts`, write a `handle<Op>` function, add a case to the dispatch switch.
3. Extend the `parameters` array on `remoteDesktopAction` if the op needs new params.

**Add a new backend:**
1. Add the backend tag to `RemoteDesktopBackend` in `src/types.ts`.
2. Add a `probe<Backend>` and `start<Backend>Session` helper in `src/lifeops/remote-desktop.ts`.
3. Extend `detectRemoteDesktopBackend` and `backendAvailable` to cover the new backend.

## Conventions / gotchas

- **OWNER role gate.** `REMOTE_DESKTOP` will not fire for non-owner entities. Check the runtime's role system if the action is unexpectedly unavailable.
- **`confirmed: true` is mandatory for `start`.** `RemoteSessionService.startSession` throws `RemoteSessionError("NOT_CONFIRMED")` otherwise. The action uses `requireConfirmation` from `@elizaos/core` to surface a confirmation prompt to the owner.
- **Pairing codes are one-time.** Each `issuePairingCode()` call rotates the code; `consume()` is single-use.
- **`suppressPostActionContinuation: true`** — opening a remote session is consumed out-of-band (a VNC viewer / SSH client), so the planner should not chain another turn.
- **`start` with no data plane returns `DATA_PLANE_NOT_CONFIGURED`.** The control plane authorizes the session and persists it, but `ingressUrl` is `null` until Tailscale (T9b) or the Eliza Cloud tunnel is wired — that explicit absence is surfaced, not papered over.
- **No business computation in this plugin's surface.** Session state and ingress URL come from `RemoteSessionService`; the action just shapes the `ActionResult` for the agent.
- **No `console.*` in server code.** Use `@elizaos/core`'s `logger`; prefix with `[remote-desktop]` and attach context objects on errors.
- See root `AGENTS.md` for repo-wide architecture commandments, logger conventions, ESM rules, and naming.
