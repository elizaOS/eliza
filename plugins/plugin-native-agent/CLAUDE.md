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

Only these scripts exist in `package.json`:

```bash
bun run --cwd plugins/plugin-native-agent build   # tsc + rollup → dist/
bun run --cwd plugins/plugin-native-agent clean   # remove dist/
bun run --cwd plugins/plugin-native-agent watch   # tsc --watch
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

- `window.__ELIZA_API_BASE__` — API server base URL (falls back to relative)
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
- **iOS local mode uses WebView ITTP, not a TCP listener.** When `mode=local` (or equivalent), the iOS plugin dispatches `Agent.request` and `Agent.chat` through `window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__` — a JS handler installed by the app's WebView bridge. If that handler is not present, all local-mode requests return HTTP 503.
- **`Agent.request` is path-only.** All implementations reject absolute URLs and paths starting with `//`. Only paths starting with `/` are accepted.
- **Body size limits.** Request and response bodies are capped at 10 MB on iOS; requests are capped at 10 MB on Android.
- **Chat uses a per-session conversation.** `AgentWeb` and the iOS native bridge lazily create a conversation via `POST /api/conversations` and cache the ID in `sessionStorage` (web) or a static class dictionary (iOS). A 404 on message send clears the cache and retries once.
- **Build outputs three artifacts:** `dist/esm/index.js` (ESM, from tsc), `dist/plugin.js` (IIFE for unpkg/CDN), `dist/plugin.cjs.js` (CJS for require). The `bun` and `development` export conditions resolve directly to `src/index.ts`.
- **iOS deployment target:** iOS 13.0 (from podspec). `callAsyncJavaScript` requires iOS 14+; the plugin falls back to a 503 response on iOS 13.
- **Timeout bounds (iOS):** clamped to 1000–120000 ms. Android default is 10000 ms, max 600000 ms.
