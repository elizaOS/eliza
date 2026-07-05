# @elizaos/plugin-messages

Android SMS overlay plugin for elizaOS — provides an SMS inbox and compose surface backed by the native `@elizaos/capacitor-messages` bridge.

## Purpose / role

Adds a Messages overlay app to elizaOS on Android. It registers three plugin views (standard, XR, TUI) that let an Eliza agent and the user read SMS threads and send text messages through the native Android SMS bridge. The plugin is opt-in; load it by including `@elizaos/plugin-messages` in the agent's plugin list. It is marked `androidOnly: true` in its elizaos app metadata, so its overlay registration is gated by the `isElizaOS()` runtime check at `src/register.ts`.

## Plugin surface

This plugin registers **views only** — no actions, providers, evaluators, services, or routes:

| View ID | Label | View type | Component export | Path |
|---|---|---|---|---|
| `messages` | Messages | (standard) | `MessagesPluginView` | `/messages` |
| `messages` | Messages XR | `xr` | `MessagesPluginView` | `/messages` |
| `messages` | Messages TUI | `tui` | `MessagesTuiView` | `/messages/tui` |

All three bundle paths point to `dist/views/bundle.js` (built by `build:views`).

Additionally registers an **overlay app** (`messagesApp`) via `@elizaos/ui`'s `registerOverlayApp` on elizaOS-capable runtimes. The overlay lazy-loads `MessagesAppView` from `./components/MessagesAppView`.

## Layout

```
src/
  plugin.ts              Plugin object — defines the three views registered with @elizaos/core
  index.ts               Public package entry — re-exports plugin, register, ui
  register.ts            Side-effect entry — calls registerMessagesApp() when isElizaOS()
  register-terminal-view.tsx  Registers the messages view for terminal rendering via @elizaos/tui
  ui.ts                  Re-exports MessagesAppView, MessagesPluginView, messagesApp, registerMessagesApp
  components/
    messages-app.ts      OverlayApp descriptor + registerMessagesApp() helper
    MessagesAppView.tsx  React components: MessagesAppView (full overlay), MessagesPluginView
                         (plugin view wrapper)
    MessagesAppView.helpers.ts  Shared helper functions for MessagesAppView
    MessagesAppView.interact.ts  interact() terminal capability handler (split from MessagesAppView.tsx)
    MessagesSpatialView.tsx  Unified spatial SMS surface (renders in GUI, XR, and TUI contexts)
    messages-view-bundle.ts  View bundle entry — re-exports interact and view components for Vite bundle
    MessagesAppView.gui.test.tsx      GUI-level tests for MessagesAppView
    MessagesAppView.helpers.test.ts   Tests for helpers
    messages-app.test.ts              Tests for overlay app descriptor/registration
    messages-bridge-contract.test.ts  Contract tests for the Capacitor bridge
    MessagesSpatialView.test.tsx      Tests for the spatial view
    MessagesTuiView.test.ts           Vitest tests for TUI view and interact() terminal capabilities
```

### Key exports

- `appMessagesPlugin` / `default` — the `Plugin` object; import this to register the plugin.
- `MessagesAppView` — full-screen overlay React component (used as the app entry).
- `MessagesPluginView` — same view, wrapped with a default `OverlayAppContext` for plugin-view use.
- `MessagesTuiView` — terminal-style React component; exposes `data-view-state` JSON for agent inspection. Exported from `src/components/MessagesAppView.tsx` only — not re-exported from the package root.
- `interact(capability, params?)` — programmatic terminal API for agents; see capabilities below. Defined in `src/components/MessagesAppView.interact.ts`; re-exported via `src/components/messages-view-bundle.ts`. Not re-exported from the package root.
- `messagesApp` / `registerMessagesApp` / `MESSAGES_APP_NAME` — overlay app descriptor and registration.

### `interact()` terminal capabilities

| Capability | Params | Returns |
|---|---|---|
| `terminal-list-threads` | `{ limit?: number }` | Thread list + `ownsSmsRole`, `smsRoleHolder` |
| `terminal-send-sms` | `{ address: string, body: string }` | `{ sent, address, bodyLength }` |
| `terminal-request-sms-role` | — | `{ requested, ownsSmsRole, smsRoleHolder }` |

## Commands

Scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-messages build          # tsup JS + vite view bundle + type declarations
bun run --cwd plugins/plugin-messages build:js       # tsup library build only
bun run --cwd plugins/plugin-messages build:views    # vite bundle for dist/views/bundle.js
bun run --cwd plugins/plugin-messages build:types    # tsc declarations
bun run --cwd plugins/plugin-messages clean          # rm -rf dist
bun run --cwd plugins/plugin-messages typecheck      # tsgo --noEmit
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
2. Export it from `src/components/MessagesAppView.tsx` (or a new file re-exported from `src/ui.ts`).
3. Add a view entry to the `views` array in `src/plugin.ts` with the correct `bundlePath`, `componentExport`, and `viewType`.
4. If the component needs to be in the view bundle, ensure it is reachable from `src/components/messages-view-bundle.ts` (the Vite entry; see `vite.config.views.ts`).

**Add a new terminal capability:**
1. Extend the `interact()` function in `src/components/MessagesAppView.interact.ts` with a new `if (capability === "...")` branch.
2. Add a corresponding test case in `src/components/MessagesTuiView.test.ts`.

**Register the plugin in an agent:**
```ts
import messagesPlugin from "@elizaos/plugin-messages";
// pass in the plugins array when constructing the AgentRuntime
```

## Conventions / gotchas

- **Android-only.** The `messagesApp` descriptor sets `androidOnly: true`. The `register.ts` side-effect is guarded by `isElizaOS()` — on non-Android or non-elizaOS runtimes, the overlay is never registered.
- **View bundle is separate from the library bundle.** `build:js` (tsup) produces `dist/index.js` for the npm package. `build:views` (vite) produces `dist/views/bundle.js` which is loaded at runtime by the plugin view system. Both must be built for a full build.
- **Capacitor bridge in tests.** `vitest.config.ts` aliases `@elizaos/capacitor-messages` → `plugins/plugin-native-messages/src/index.ts` and `@elizaos/capacitor-system` → `plugins/plugin-native-system/src/index.ts`. Tests mock both via `vi.mock`.
- **SMS role vs bridge mode.** The UI shows two modes: "Default SMS app" (owns the role, full inbox) and "Android SMS bridge" (read-only via the capacitor bridge, no role held). Agents can request the role via `interact("terminal-request-sms-role")` or via the TUI button.
- **`data-view-state` attribute.** `MessagesTuiView` serialises its full state to `data-view-state` on the root element; agent test harnesses can read it without parsing inner DOM structure.
- **Cross-view recipient handoff.** `MessagesAppView` consumes a one-shot `{ recipient }` payload via `consumeNavigateViewPayload("messages")` from `@elizaos/ui/app-navigate-view` on mount, opening the composer with the "To" field pre-seeded. Callers dispatch `eliza:navigate:view` with `{ viewId: "messages", viewPath: "/messages", payload: { recipient } }`; the shared UI module must stay generic and contain no Messages-specific pending state.
- **Spatial view.** `MessagesSpatialView` is the unified presentational component that renders correctly in GUI, XR, and TUI contexts. It is purely presentational (a snapshot + action callback in, spatial primitives out) and does not import Capacitor runtime code, making it safe to render in the Node agent process.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
