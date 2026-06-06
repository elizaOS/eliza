# @elizaos/plugin-remote-desktop

Owner-only remote desktop session control for Eliza agents. Lets the owner connect to the agent's host machine from another device (typically a phone) over Tailscale VNC/SSH or an ngrok TCP tunnel, gated by an explicit confirmation step and (in cloud mode) a 6-digit pairing code.

## Status: scaffolded, migration pending

This plugin was extracted from `@elizaos/plugin-personal-assistant` as part of the LifeOps decomposition. The plugin surface (action metadata, types, package layout) is in place and the package compiles standalone, but the action handler is a **stub** that returns `NOT_IMPLEMENTED_MIGRATION_PENDING`. The real implementation still lives in `@elizaos/plugin-personal-assistant` and will be ported here in the next migration pass.

## Migration mapping

| New location (this plugin) | Source in `@elizaos/plugin-personal-assistant` |
|---|---|
| `src/actions/remote-desktop.ts` | `plugins/plugin-personal-assistant/src/actions/remote-desktop.ts` |
| `src/lifeops/remote-desktop.ts` (todo) | `plugins/plugin-personal-assistant/src/lifeops/remote-desktop.ts` |
| `src/remote/remote-session-service.ts` (todo) | `plugins/plugin-personal-assistant/src/remote/remote-session-service.ts` |
| `src/remote/pairing-code.ts` (todo) | `plugins/plugin-personal-assistant/src/remote/pairing-code.ts` |
| `src/types.ts` (already extracted) | inline in `lifeops/remote-desktop.ts` + `remote/remote-session-service.ts` |

The follow-up migration pass will:

1. Move the helpers above into this plugin verbatim.
2. Either vendor or share the `resolveActionArgs` helper from `plugins/plugin-personal-assistant/src/actions/lib/resolve-action-args.ts`.
3. Replace the stub handler with the full `handleStart/handleStatus/handleEnd/handleList/handleRevoke` implementation.
4. Have `@elizaos/plugin-personal-assistant` re-export `remoteDesktopAction` from this plugin during the deprecation window, then remove the action from lifeops in a later release.

## Plugin surface

**Action**

- `REMOTE_DESKTOP` — umbrella action with op-based dispatch:
  - `start` — open a session. Requires `confirmed: true`. In cloud mode also requires a 6-digit `pairingCode`. `ELIZA_REMOTE_LOCAL_MODE=1` skips the pairing-code requirement.
  - `status` — look up a session by `sessionId`.
  - `end` — close a session by `sessionId`.
  - `list` — list active sessions.
  - `revoke` — revoke an active session by `sessionId`.

  Role gate: `OWNER`. Contexts: `browser`, `automation`, `settings`, `admin`, `terminal`. The action sets `suppressPostActionContinuation: true` to keep the planner from chaining additional turns after a remote session is opened.

No providers. No services. No schema. (The session store is currently in-memory + a JSON file under `resolveStateDir()`. After migration this can stay file-backed or move to a drizzle table — that decision is deferred to the migration pass.)

## Config / env vars

Inherited from the underlying remote-desktop helpers (still in `@elizaos/plugin-personal-assistant` until the migration). Listed here so the contract is documented in one place:

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
  types.ts                       Shared types (RemoteDesktopSession, RemoteSession, ...)
  actions/
    remote-desktop.ts            REMOTE_DESKTOP umbrella action (handler stubbed pending migration)
  lifeops/                       (reserved for migrated remote-desktop.ts)
  remote/                        (reserved for migrated remote-session-service.ts + pairing-code.ts)
```

## Conventions / gotchas

- **OWNER role gate.** `REMOTE_DESKTOP` will not fire for non-owner entities.
- **`confirmed: true` is mandatory for `start`.** The action's underlying service rejects unconfirmed starts. The confirmation prompt is rendered by `requireConfirmation` from `@elizaos/core`.
- **`suppressPostActionContinuation`.** The action sets this flag so the planner does not chain another turn after a remote session is opened — opening a session is a side-effect the owner consumes out-of-band (a VNC viewer / SSH client).
- **No business computation in this plugin's surface.** Session state and ingress URL come from the underlying service; the action just shapes the `ActionResult` for the agent.
- See root `AGENTS.md` for repo-wide architecture commandments, logger conventions, and ESM rules.
