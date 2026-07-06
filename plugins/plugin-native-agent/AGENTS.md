# @elizaos/capacitor-agent

Capacitor plugin that exposes agent lifecycle control (start, stop, status, chat, raw request) to a WebView-hosted Eliza app on iOS, Android, and web/desktop.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin — not an elizaOS runtime plugin. It provides a cross-platform JS API (`Agent.*`) that a Capacitor-hosted WebView can call to manage the embedded Eliza agent runtime. It ships native implementations for iOS (Swift) and Android (Kotlin), plus a web/Electrobun fallback that delegates to the HTTP API server. It is registered via `registerPlugin("Agent", ...)` in TypeScript and loaded by whatever Capacitor app embeds it. It is not default-enabled in elizaOS; it must be installed by a Capacitor app.

## Plugin surface

This is not an elizaOS action/provider/evaluator plugin. The JS-side entry point is `Agent` (exported from `src/index.ts`), registered as Capacitor plugin name `"Agent"`. It exposes:

| Method | Description |
|---|---|
| `Agent.start(options?)` | Start the agent runtime; resolves with `AgentStatus` |
| `Agent.stop()` | Stop the agent runtime; resolves with `{ ok: boolean }` |
| `Agent.getStatus()` | Poll current runtime state; resolves with `AgentStatus` |
| `Agent.chat({ text })` | Send a DM-channel message; resolves with `ChatResult` |
| `Agent.getLocalAgentToken()` | Read the per-boot bearer token (Android local agent) |
| `Agent.request({ path, method?, headers?, body?, timeoutMs? })` | Forward a path-only HTTP request to the local agent backend |

Key exported types from `src/definitions.ts`: `AgentStatus`, `AgentStartOptions`, `ChatResult`, `LocalAgentTokenResult`, `AgentRequestOptions`, `AgentRequestResult`, `AgentPlugin`.

## Layout

```
plugins/plugin-native-agent/
  src/
    index.ts            Entry: registerPlugin("Agent") + re-exports definitions
    definitions.ts      All TypeScript interfaces (AgentPlugin, AgentStatus, etc.)
    web.ts              Web/Electrobun fallback: HTTP calls to the API server
  ios/Sources/AgentPlugin/
    AgentPlugin.swift   iOS native bridge; resolves endpoint from config keys
  android/src/main/java/ai/eliza/plugins/agent/
    AgentPlugin.kt      Android native bridge; calls ElizaAgentService via reflection
  android/src/main/AndroidManifest.xml
  ElizaosCapacitorAgent.podspec  CocoaPods spec; pod name ElizaosCapacitorAgent
  rollup.config.mjs     Bundles dist/plugin.js (IIFE) + dist/plugin.cjs.js
  tsconfig.json
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-agent clean           # remove build output
bun run --cwd plugins/plugin-native-agent build           # build package artifacts
bun run --cwd plugins/plugin-native-agent typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-agent lint            # mutating Biome check
bun run --cwd plugins/plugin-native-agent lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-agent format          # write formatting
bun run --cwd plugins/plugin-native-agent format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-agent test            # run package tests
bun run --cwd plugins/plugin-native-agent prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-agent watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-agent build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Config / env vars

### iOS endpoint resolution (checked in order; first non-empty wins)

The iOS plugin reads endpoint config from: call options → Capacitor plugin config → `Info.plist` → process env → `UserDefaults`.

API base keys (any one of):
- `apiBase`, `baseUrl`, `baseURL`, `agentApiBase`
- `ELIZA_AGENT_API_BASE`, `ELIZA_API_BASE`, `ELIZA_IOS_API_BASE`, `ELIZA_IOS_REMOTE_API_BASE`
- `ELIZA_MOBILE_API_BASE`, `VITE_ELIZA_IOS_API_BASE`, `VITE_ELIZA_MOBILE_API_BASE`

Token keys (any one of):
- `apiToken`, `token`, `agentApiToken`
- `ELIZA_AGENT_API_TOKEN`, `ELIZA_API_TOKEN`, `ELIZA_IOS_API_TOKEN`, `ELIZA_IOS_REMOTE_API_TOKEN`
- `ELIZA_MOBILE_API_TOKEN`, `VITE_ELIZA_IOS_API_TOKEN`, `VITE_ELIZA_MOBILE_API_TOKEN`

Runtime mode keys (selects local ITTP mode on iOS):
- `mode`, `runtimeMode`, `agentRuntimeMode`
- `ELIZA_IOS_RUNTIME_MODE`, `ELIZA_MOBILE_RUNTIME_MODE`
- `VITE_ELIZA_IOS_RUNTIME_MODE`, `VITE_ELIZA_MOBILE_RUNTIME_MODE`
- Values that activate local mode: `local`, `ios-local`, `sideload-local`, `dev-local`

### Web fallback (AgentWeb)

- boot-config `apiBase` (`window.__ELIZAOS_APP_BOOT_CONFIG__`) — API server base URL (falls back to relative)
- `window.__ELIZA_API_TOKEN__` — bearer token (falls back to `sessionStorage.eliza_api_token`)

### Android

Android uses reflection to call `ElizaAgentService` (resolved by scanning registered services for a class ending in `.ElizaAgentService` in the app's package). No env keys are read by the plugin itself; the service holds the per-boot bearer token.

## How to extend

**Add a new method to the JS interface:**

1. Add the method signature to `AgentPlugin` in `src/definitions.ts`.
2. Implement it in `src/web.ts` (extends `WebPlugin`).
3. Add the native `@objc func` + `CAPPluginMethod` entry in `ios/Sources/AgentPlugin/AgentPlugin.swift`.
4. Add the `@PluginMethod fun` in `android/src/main/java/ai/eliza/plugins/agent/AgentPlugin.kt`.
5. Run `bun run --cwd plugins/plugin-native-agent build` to compile TypeScript.
6. For iOS: rebuild the Xcode project after `pod install`. For Android: rebuild the Gradle module.

## Conventions / gotchas

- **Not an elizaOS action plugin.** This is a Capacitor plugin. There is no `Plugin` object from `@elizaos/core`; do not add one. The root AGENTS.md architecture rules apply to surrounding elizaOS code, not to this package.
- **Android uses reflection.** `AgentPlugin.kt` locates `ElizaAgentService` via reflection to avoid a Gradle cycle. If the service class is renamed or not registered in `AndroidManifest.xml`, all Android calls will fail at runtime.
- **iOS local mode uses WebView ITTP, not a TCP listener.** When `mode=local` (or equivalent), the iOS plugin dispatches `Agent.request` and `Agent.chat` through `window.__ELIZA_BRIDGE__?.iosLocalAgentRequest` — a JS handler installed by the app's WebView bridge. If that handler is not present, all local-mode requests return HTTP 503.
- **`Agent.request` is path-only.** All implementations reject absolute URLs and paths starting with `//`. Only paths starting with `/` are accepted.
- **Body size limits.** Request and response bodies are capped at 10 MB on iOS; requests are capped at 10 MB on Android.
- **Chat uses a per-session conversation.** `AgentWeb` and the iOS native bridge lazily create a conversation via `POST /api/conversations` and cache the ID in `sessionStorage` (web) or a static class dictionary (iOS). A 404 on message send clears the cache and retries once.
- **Build outputs three artifacts:** `dist/esm/index.js` (ESM, from tsc), `dist/plugin.js` (IIFE for unpkg/CDN), `dist/plugin.cjs.js` (CJS for require). The `bun` and `development` export conditions resolve directly to `src/index.ts`.
- **iOS deployment target:** iOS 13.0 (from podspec). `callAsyncJavaScript` requires iOS 14+; the plugin falls back to a 503 response on iOS 13.
- **Timeout bounds (iOS):** clamped to 1000–120000 ms. Android default is 10000 ms, max 600000 ms.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->
