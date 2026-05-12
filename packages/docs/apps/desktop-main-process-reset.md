---
title: "Desktop main-process reset (menu)"
sidebarTitle: "Main-process reset"
description: "Why Reset Eliza runs in the Electrobun main process, how the renderer syncs, and how we test the flow."
---

# Desktop: main-process “Reset Eliza…” (and renderer sync)

This page explains **why** the application menu reset does not rely on the webview for the critical path, **how** the renderer still applies the same local UI wipe as Settings, and **where** the code and tests live.

## Problem we were solving

### WKWebView / native dialog + network

On macOS (Electrobun + WKWebView), after a **native** confirm dialog returns, the webview can fail to process **`fetch`** or bridge RPC on the same turn—the UI looks “stuck” even though the user confirmed reset. **Why document this:** it is easy to assume the bug is “reset API broken” when it is actually **event-loop scheduling** between native UI and the renderer.

**Decision:** run **confirm + `POST /api/agent/reset` + restart + poll** in the **main process**, where Node/Bun networking is reliable. The renderer then only **syncs local state** when main pushes completion—no duplicate HTTP client required for the wipe itself.

### Wrong API base (embedded vs external dev server)

`ELIZA_DESKTOP_API_BASE` often points at a **Vite/API dev server** (e.g. `:31337`). If that process is down but the **embedded** agent is still running on a **dynamic loopback port**, a blind POST to the env URL fails. **Why:** two valid “API homes” exist in desktop dev; menu reset must pick one the **main process can actually reach**.

**Decision:** **probe** each candidate with `GET /api/status` and accept only **`res.ok` (2xx)**—not merely “connected” (4xx would still be wrong for a reset target). The first reachable base wins. **Why `res.ok`:** a 403/500 means “this URL is not a healthy agent API for our purposes,” not “use this for `POST /api/agent/reset`."

### One local UI wipe, two entry points

Settings still uses **`handleReset`** in the renderer (confirm in webview + full flow). The menu uses **main** for server work, then must **reconcile** onboarding, client base URL, cloud flags, conversations, etc. **Why:** duplicating that logic in TypeScript main + React renderer guarantees drift.

**Decision:** extract **`completeResetLocalStateAfterServerWipe`** and **`handleResetAppliedFromMainCore`** into testable modules; **`AppProvider`** wires real `client` + setters. Main sends **`desktopTrayMenuClick`** with **`itemId: "menu-reset-eliza-applied"`** and an **`agentStatus`** snapshot from **`GET /api/status`** after restart so the UI can call **`setAgentStatus`** without guessing.

## End-to-end sequence (high level)

1. User chooses **Eliza → Reset Eliza…**
2. **Main:** `showWindow`, native **warning** dialog (Reset / Cancel).
3. **Main:** resolve **reachable** API base (embedded port first, then configured base).
4. **Main:** `POST /api/agent/reset`.
5. **Main:** if **local** embedded mode → `restartClearingLocalDb` + push API base to renderer; else `POST /api/agent/restart` (best effort) for external API.
6. **Main:** poll **`GET /api/status`** until `state === "running"` (or timeout → fallback payload).
7. **Main:** `sendToActiveRenderer("desktopTrayMenuClick", { itemId: "menu-reset-eliza-applied", agentStatus })`.
8. **Renderer:** **`handleResetAppliedFromMain`** → lifecycle guard → **`completeResetLocalStateAfterServerWipe`** (same wipes as post-`handleReset` server path).

## Code map

| Concern | Location |
|--------|----------|
| Menu template / action ids | `apps/app/electrobun/src/application-menu.ts` |
| Native confirm + orchestration | `apps/app/electrobun/src/index.ts` (`resetElizaFromApplicationMenu`) |
| Testable fetch/restart/poll core | `apps/app/electrobun/src/menu-reset-from-main.ts` |
| Tray subscription (legacy `menu-reset-eliza` + applied) | `eliza/packages/app-core/src/shell/DesktopTrayRuntime.tsx` |
| Renderer sync + lifecycle | `eliza/packages/app-core/src/state/handle-reset-applied-from-main.ts`, `complete-reset-local-state-after-wipe.ts` |
| Parse `agentStatus` from push payload | `eliza/packages/app-core/src/state/parsers.ts` (`parseAgentStatusFromMainMenuResetPayload`) |

## Tests

| Suite | File | What it proves |
|-------|------|----------------|
| Main reset core | `apps/app/electrobun/src/__tests__/menu-reset-from-main.test.ts` | Candidate ordering, skip non-ok HTTP, poll until running, embedded vs external branches, failed POST |
| Renderer reset | `eliza/packages/app-core/src/state/reset-main-process.test.ts` | Order of local wipes, onboarding options failure path, lifecycle busy / begin-fail / success / throw + `finishLifecycleAction` |
| Payload parse | `eliza/packages/app-core/src/state/parsers.test.ts` | Valid / invalid `agentStatus` on tray payload |

**Why separate from kitchen-sink string checks:** `kitchen-sink` asserts wiring in `index.ts`; **behavior** lives in the extracted modules so CI fails when reset semantics regress without loading Electrobun.

## Related documentation

- [Desktop app](/apps/desktop) — native menu overview (table updated to match main-process reset).
- [Environment variables](/cli/environment) — `ELIZA_DISABLE_EDGE_TTS` and other runtime flags.
- [TTS / Edge plugin](/plugin-registry/tts) — Microsoft Edge TTS cloud disclosure when orchestrator auto-loads Edge TTS.
- [Contributing — Testing](/guides/contributing) — Vitest include globs for `packages/app-core`.

## Tray RPC wait timeout

`DesktopTrayRuntime` polls until `getElectrobunRendererRpc()` exists, with a **10s** cap. **Why:** bridge readiness can lag first paint; without a timeout, logs never explain “menu reset won’t work until reload.” **Why `clearTimeout` on unmount:** avoid calling `clearInterval` / `console.warn` after unmount when the user navigates away quickly.
