# @elizaos/plugin-remote-desktop

Owner-only remote desktop session control for Eliza agents. Lets the owner connect to the agent's host machine from another device (typically a phone) over Tailscale VNC/SSH or an ngrok TCP tunnel, gated by an explicit confirmation step and (in cloud mode) a 6-digit pairing code.

## Status: live

Extracted from `@elizaos/plugin-personal-assistant` as part of the LifeOps decomposition. This plugin owns the full remote-desktop implementation — the `REMOTE_DESKTOP` action, the backend-detection engine, and the in-process `RemoteSessionService` control plane. PA re-exports `remoteDesktopAction` + `detectRemoteDesktopBackend` through a thin shim for back-compat and loads this plugin at init via `ensureLifeOpsRemoteDesktopPluginRegistered`. Exactly one plugin registers the `REMOTE_DESKTOP` action — this one.

## Migration mapping (complete)

| Location (this plugin) | Former source in `@elizaos/plugin-personal-assistant` |
|---|---|
| `src/actions/remote-desktop.ts` | `src/actions/remote-desktop.ts` |
| `src/lifeops/remote-desktop.ts` | `src/lifeops/remote-desktop.ts` |
| `src/remote/remote-session-service.ts` | `src/remote/remote-session-service.ts` |
| `src/remote/pairing-code.ts` | `src/remote/pairing-code.ts` |
| `src/types.ts` | inline in the engine + service (now canonical here) |

The handler dispatches subactions via `resolveActionArgs` from `@elizaos/core`. PA's old `src/actions/remote-desktop.ts` is now a thin re-export shim.

## Plugin surface

**Action**

- `REMOTE_DESKTOP` — umbrella action with op-based dispatch:
  - `start` — open a session. Requires `confirmed: true`. In cloud mode also requires a 6-digit `pairingCode`. `ELIZA_REMOTE_LOCAL_MODE=1` skips the pairing-code requirement.
  - `status` — look up a session by `sessionId`.
  - `end` — close a session by `sessionId`.
  - `list` — list active sessions.
  - `revoke` — revoke an active session by `sessionId`.

  Role gate: `OWNER`. Contexts: `browser`, `automation`, `settings`, `admin`, `terminal`. The action sets `suppressPostActionContinuation: true` to keep the planner from chaining additional turns after a remote session is opened.

No providers. No services. No schema. The session store is in-memory plus a JSON file under `resolveStateDir()/lifeops/remote-sessions.json`.

## Config / env vars

Read by this plugin's engine (`src/lifeops/remote-desktop.ts`) and control-plane service (`src/remote/remote-session-service.ts`):

| Variable | Required | Description |
|---|---|---|
| `ELIZA_REMOTE_LOCAL_MODE` | No | Set to `1` to skip the pairing-code requirement on `start`. Confirmation is still required. |
| `ELIZA_REMOTE_ACCESS_TOKEN` | No | Token used by external clients that want to attach to a session. |
| `ELIZA_TAILSCALE_NODE` | No | Override the Tailscale node hostname used for VNC/SSH URLs. |
| `ELIZA_NGROK_AUTH_TOKEN` | No | ngrok auth token. Required to use the `ngrok-vnc` backend. Passed via env, never argv. |
| `ELIZA_TEST_REMOTE_DESKTOP_BACKEND` | No | Set to `1`/`true`/`fixture` to force mock mode (no real backend probe). |

## Commands

```bash
bun run --cwd plugins/plugin-remote-desktop typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-remote-desktop test        # vitest run
bun run --cwd plugins/plugin-remote-desktop build       # bun bundle + tsc decl emit
bun run --cwd plugins/plugin-remote-desktop check       # typecheck + test
bun run --cwd plugins/plugin-remote-desktop clean       # rm -rf dist .turbo
```

## Layout

```
src/
  index.ts                       Public exports; default-exports remoteDesktopPlugin
  plugin.ts                      Plugin object (actions: [remoteDesktopAction])
  types.ts                       Canonical types (RemoteDesktopSession, RemoteSession, ...)
  actions/
    remote-desktop.ts            REMOTE_DESKTOP umbrella action (real handler; resolveActionArgs dispatch)
  lifeops/
    remote-desktop.ts            Backend detection (Tailscale/ngrok/VNC) + in-process session store
  remote/
    remote-session-service.ts    Control-plane service + pairing-code gate + data-plane handoff
    pairing-code.ts              6-digit rolling one-time pairing codes
```

## Conventions / gotchas

- **OWNER role gate.** `REMOTE_DESKTOP` will not fire for non-owner entities.
- **`confirmed: true` is mandatory for `start`.** The action's underlying service rejects unconfirmed starts. The confirmation prompt is rendered by `requireConfirmation` from `@elizaos/core`.
- **`suppressPostActionContinuation`.** The action sets this flag so the planner does not chain another turn after a remote session is opened — opening a session is a side-effect the owner consumes out-of-band (a VNC viewer / SSH client).
- **No business computation in this plugin's surface.** Session state and ingress URL come from the underlying service; the action just shapes the `ActionResult` for the agent.
- See root `AGENTS.md` for repo-wide architecture commandments, logger conventions, and ESM rules.
