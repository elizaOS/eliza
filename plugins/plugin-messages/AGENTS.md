# @elizaos/plugin-messages

Android SMS overlay plugin for elizaOS — provides an SMS inbox and compose surface backed by the native `@elizaos/capacitor-messages` bridge.

## Purpose / role

Adds a Messages GUI view to elizaOS on Android. It lets an Eliza agent and the user read SMS threads and send text messages through the native Android SMS bridge. The plugin is opt-in; load it by including `@elizaos/plugin-messages` in the agent's plugin list. It is marked `androidOnly: true` in its elizaOS app metadata; there is no side-effect app-register module.

## Plugin surface

This plugin registers **views only** — no actions, providers, evaluators, services, or routes:

| View ID | Label | View type | Component export | Path |
|---|---|---|---|---|
| `messages` | Messages | `gui` | `MessagesView` | `/messages` |

The view bundle path points to `dist/views/bundle.js` (built by `build:views`).

## Layout

```
src/
  plugin.ts              Plugin object — defines the three views registered with @elizaos/core
  index.ts               Public package entry — re-exports plugin and ui
  ui.ts                  Re-exports MessagesView for renderer consumers
  components/
    MessagesView.tsx     GUI data wrapper and Android bridge owner
    messages-view-helpers.ts  Shared helper functions for MessagesView
    messages-interact.ts  interact() capability handler for the view bundle
    MessagesSpatialView.tsx  Spatial SMS surface retained for future modality adapters
    messages-view-bundle.ts  View bundle entry — re-exports interact and view components for Vite bundle
    MessagesView.test.tsx             GUI-level tests for MessagesView
    messages-view-helpers.test.ts     Tests for helpers
    messages-bridge-contract.test.ts  Contract tests for the Capacitor bridge
```

### Key exports

- `appMessagesPlugin` / `default` — the `Plugin` object; import this to register the plugin.
- `MessagesView` — GUI React component used by the plugin view declaration.
- `interact(capability, params?)` — programmatic view API for agents; see capabilities below. Defined in `src/components/messages-interact.ts`; re-exported via `src/components/messages-view-bundle.ts`. Not re-exported from the package root.

### `interact()` capabilities

| Capability | Params | Returns |
|---|---|---|
| `list-threads` | `{ limit?: number }` | Thread list + `ownsSmsRole`, `smsRoleHolder` |
| `send-sms` | `{ address: string, body: string }` | `{ sent, address, bodyLength }` |
| `request-sms-role` | — | `{ requested, ownsSmsRole, smsRoleHolder }` |

## Commands

Scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-messages build          # tsup JS + vite view bundle + type declarations
bun run --cwd plugins/plugin-messages build:js       # tsup library build only
bun run --cwd plugins/plugin-messages build:views    # vite bundle for dist/views/bundle.js
bun run --cwd plugins/plugin-messages build:types    # tsc declarations
bun run --cwd plugins/plugin-messages clean          # rm -rf dist
bun run --cwd plugins/plugin-messages typecheck      # tsc --noEmit
bun run --cwd plugins/plugin-messages lint           # biome check src
bun run --cwd plugins/plugin-messages test           # vitest run
```

## Config / env vars

This plugin reads **no environment variables** directly. All SMS and system-role operations go through the Capacitor plugin bridge:

- `@elizaos/capacitor-messages` — `Messages.listMessages({ limit })`, `Messages.sendSms({ address, body })`
- `@elizaos/capacitor-system` — `System.getStatus()`, `System.requestRole({ role: "sms" })`

The Android **default SMS role** (`android.app.role.SMS`) must be granted to the elizaOS app for full read/send capability. The UI surfaces a "Set default SMS" prompt when the role is not held.

## How to extend

**Add a new view:**
1. Define the React component in `src/components/`.
2. Export it from a view component module and re-export it from `src/ui.ts`.
3. Add a view entry to the `views` array in `src/plugin.ts` with the correct `bundlePath`, `componentExport`, and modality metadata.
4. If the component needs to be in the view bundle, ensure it is reachable from `src/components/messages-view-bundle.ts` (the Vite entry; see `vite.config.views.ts`).

**Add a new interact capability:**
1. Extend the `interact()` function in `src/components/messages-interact.ts` with a new `if (capability === "...")` branch.
2. Add a corresponding test case for the interact handler.

**Register the plugin in an agent:**
```ts
import messagesPlugin from "@elizaos/plugin-messages";
// pass in the plugins array when constructing the AgentRuntime
```

## Conventions / gotchas

- **Android-only.** Package metadata marks the view app as `androidOnly: true`, and the plugin view declaration sets `nativeOs: true`. Do not add `elizaos.appRegister` unless a real renderer side-effect module exists.
- **View bundle is separate from the library bundle.** `build:js` (tsup) produces `dist/index.js` for the npm package. `build:views` (vite) produces `dist/views/bundle.js` which is loaded at runtime by the plugin view system. Both must be built for a full build.
- **Capacitor bridge in tests.** `vitest.config.ts` aliases `@elizaos/capacitor-messages` → `plugins/plugin-native-messages/src/index.ts` and `@elizaos/capacitor-system` → `plugins/plugin-native-system/src/index.ts`. Tests mock both via `vi.mock`.
- **SMS role vs bridge mode.** The UI shows two modes: "Default SMS app" (owns the role, full inbox) and "Android SMS bridge" (read-only via the capacitor bridge, no role held). Agents can request the role via the interact handler.
- **Interact state.** Agent-driven tests should use the explicit interact handler
  and view snapshot seams instead of parsing renderer-specific DOM.
- **Cross-view recipient handoff.** `MessagesView` consumes a one-shot `{ recipient }` payload via `consumeNavigateViewPayload("messages")` from `@elizaos/ui/app-navigate-view` on mount, opening the composer with the "To" field pre-seeded. Callers dispatch `eliza:navigate:view` with `{ viewId: "messages", viewPath: "/messages", payload: { recipient } }`; the shared UI module must stay generic and contain no Messages-specific pending state.
- **Spatial view.** `MessagesSpatialView` is a presentational component retained for future modality adapters. It is purely presentational (a snapshot + action callback in, spatial primitives out) and does not import Capacitor runtime code.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
