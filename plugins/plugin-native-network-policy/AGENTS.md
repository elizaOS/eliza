# @elizaos/capacitor-network-policy

Capacitor plugin that surfaces Android `metered` and iOS `isExpensive`/`isConstrained` network-link hints to Eliza agents running on mobile.

## Purpose / role

This is a [Capacitor](https://capacitorjs.com/) plugin — not a standard elizaOS plugin registered via `Plugin` object. It bridges OS-level network-metering signals to TypeScript for use by the voice-model auto-updater (R5-versioning §4). On import it installs `globalThis.ElizaNetworkPolicy` so `plugin-local-inference/src/services/network-policy.ts` can query the bridge without a compile-time Capacitor dependency. It is loaded explicitly by the mobile app bootstrap — it is not auto-enabled by the elizaOS runtime.

## Plugin surface

This plugin does **not** register elizaOS actions, providers, services, evaluators, routes, or events. It is a Capacitor bridge plugin only.

Capacitor bridge name: `ElizaNetworkPolicy`

Exported TypeScript API (from `src/definitions.ts`):

| Symbol | Description |
|--------|-------------|
| `NetworkPolicy` | Capacitor plugin handle registered as `"ElizaNetworkPolicy"`. |
| `installNetworkPolicyGlobal()` | Installs `globalThis.ElizaNetworkPolicy`. Called as a side-effect on import. |
| `NetworkPolicyPlugin` | Interface with two methods (see below). |
| `MeteredHint` | Return type of `getMeteredHint()` — `{ metered: boolean | null, source: "android-os" }`. |
| `PathHints` | Return type of `getPathHints()` — `{ isExpensive: boolean, isConstrained: boolean, source: "nw-path-monitor" }`. |

Bridge methods:

| Method | Platform | What it reads |
|--------|----------|----------------|
| `getMeteredHint()` | Android (safe fallback on iOS/web) | `ConnectivityManager.getNetworkCapabilities(activeNetwork).hasCapability(NET_CAPABILITY_NOT_METERED)`. Returns `metered: null` when there is no active network, permission is denied, or the capability object is unavailable. |
| `getPathHints()` | iOS (safe fallback on Android/web) | `NWPathMonitor.currentPath.isExpensive` and `.isConstrained`. Returns `false/false` on Android. |

Web fallback (`src/web.ts`): reads `navigator.connection.saveData`; returns `metered: null` when `saveData` is false or unavailable — never assumes "not metered", so the policy decision falls through to `unknown → ask`.

## Layout

```
plugins/plugin-native-network-policy/
  src/
    definitions.ts          TypeScript interfaces: MeteredHint, PathHints, NetworkPolicyPlugin
    index.ts                registerPlugin("ElizaNetworkPolicy") + installNetworkPolicyGlobal()
    web.ts                  Browser WebPlugin fallback (navigator.connection.saveData)
  android/
    src/main/java/ai/eliza/plugins/networkpolicy/
      NetworkPolicyPlugin.kt  Android impl — ConnectivityManager + NET_CAPABILITY_NOT_METERED
  ios/
    Sources/NetworkPolicyPlugin/
      NetworkPolicyPlugin.swift  iOS impl — NWPathMonitor (long-lived, read on demand)
  ElizaosCapacitorNetworkPolicy.podspec  CocoaPods spec (iOS 13+, Swift 5.1)
  rollup.config.mjs          Builds IIFE (dist/plugin.js) and CJS (dist/plugin.cjs.js)
  tsconfig.json
  package.json
```

## Commands

```bash
bun run --cwd plugins/plugin-native-network-policy build    # clean + tsc + rollup
bun run --cwd plugins/plugin-native-network-policy clean    # remove dist/
```

No test or lint scripts are defined in this package's `package.json`; use repo-root tooling.

## Config / env vars

None. This plugin reads no environment variables and has no elizaOS `settings` fields. All behavior is determined at runtime by the OS network state.

## How to extend

**Add a new bridge method:**

1. Add the method signature to `src/definitions.ts` (`NetworkPolicyPlugin` interface) with its return type interface.
2. Implement the method in `src/web.ts` (`NetworkPolicyWeb` class) — return a safe conservative default.
3. Implement in `android/src/main/java/ai/eliza/plugins/networkpolicy/NetworkPolicyPlugin.kt` — annotate with `@PluginMethod`.
4. Implement in `ios/Sources/NetworkPolicyPlugin/NetworkPolicyPlugin.swift` — add a `CAPPluginMethod` entry to `pluginMethods` and an `@objc func`.
5. Re-export from `src/index.ts` if needed; `export * from "./definitions"` already covers new interfaces there.

## Conventions / gotchas

- **Not a standard elizaOS plugin.** There is no `Plugin` object, no `actions`/`providers` array. The Capacitor bridge is the surface.
- **Side-effect on import.** Importing `@elizaos/capacitor-network-policy` calls `installNetworkPolicyGlobal()` immediately — `globalThis.ElizaNetworkPolicy` is set as a side effect.
- **Platform symmetry:** both methods exist on both platforms and return conservative fallback values on the non-native platform. iOS callers should use `getPathHints()`; Android callers should use `getMeteredHint()`. The consuming code in `plugin-local-inference` is the authoritative caller — match its expectations.
- **`metered: null` means "unknown, ask the user"** — not "not metered." Do not conflate `null` with `false`.
- **iOS monitor lifecycle:** the Swift implementation keeps one long-lived `NWPathMonitor` started in `load()`. Do not start/stop it per call.
- **Android permission:** `ACCESS_NETWORK_STATE` is required in the app's `AndroidManifest.xml`. The plugin catches `SecurityException` and returns `metered: null` rather than crashing.
- **Build outputs:** `dist/plugin.js` (IIFE for web bundlers), `dist/plugin.cjs.js` (Node/CJS), `dist/esm/index.js` (ESM via tsc). The `bun`/`development` export conditions resolve directly to `src/index.ts`.
- **Peer dep:** `@capacitor/core ^8.3.1`. The consuming app must provide this.
- **CocoaPods:** `ElizaosCapacitorNetworkPolicy.podspec` targets iOS 13+. Swift 5.1 minimum.
- See the repo root `AGENTS.md` for repo-wide architecture rules, logger conventions, and commit workflow.
