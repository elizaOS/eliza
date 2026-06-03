# @elizaos/capacitor-network-policy

Android + iOS Capacitor plugin that surfaces OS-level network-metering hints to Eliza agents running on mobile devices.

## What it does

The voice-model auto-updater in `plugin-local-inference` must decide whether to download updated model weights over the current network link. This plugin bridges two OS APIs:

- **Android** — `ConnectivityManager.getNetworkCapabilities(activeNetwork).hasCapability(NET_CAPABILITY_NOT_METERED)`. Returns `metered: true | false | null` (`null` = unknown/no-permission).
- **iOS** — `NWPathMonitor.currentPath.isExpensive` and `.isConstrained`. `isExpensive` is Apple's canonical "treat as metered" flag (covers cellular and tethered hotspot Wi-Fi). `isConstrained` is Low Data Mode.
- **Web / browser fallback** — reads `navigator.connection.saveData`; returns `null` when the signal is absent so the policy falls through to "ask the user."

On import, the plugin installs `globalThis.ElizaNetworkPolicy` so `plugin-local-inference/src/services/network-policy.ts` can call into the bridge without a compile-time Capacitor dependency.

## Capacitor bridge

Bridge name: `ElizaNetworkPolicy`

### `getMeteredHint(): Promise<MeteredHint>`

**Android (safe fallback on iOS/web).** Returns `{ metered: boolean | null, source: "android-os" }`.

| `metered` value | Meaning |
|-----------------|---------|
| `true` | Link is metered — defer or skip the download. |
| `false` | Link is not metered — download is safe. |
| `null` | No active network, permission denied, or OS cannot report. Policy falls through to "ask." |

> Android explicitly warns that transport type (cellular vs. Wi-Fi) is not a reliable proxy for metering. Use only the `NET_CAPABILITY_NOT_METERED` flag.

### `getPathHints(): Promise<PathHints>`

**iOS (safe fallback on Android/web).** Returns `{ isExpensive: boolean, isConstrained: boolean, source: "nw-path-monitor" }`.

| Field | Meaning |
|-------|---------|
| `isExpensive` | `true` when the link is cellular or a cellular hotspot — treat as metered. |
| `isConstrained` | `true` when Low Data Mode is on — user has explicitly asked the OS to limit non-essential traffic. |

Returns `false/false` on Android (use `getMeteredHint()` there).

## Requirements

- `@capacitor/core ^8.3.1` (peer dependency — provided by the consuming app)
- Android: `ACCESS_NETWORK_STATE` permission in `AndroidManifest.xml`
- iOS 13+, Swift 5.1+

## Installation

```bash
bun add @elizaos/capacitor-network-policy
npx cap sync
```

For iOS, add the pod to your Podfile:

```ruby
pod 'ElizaosCapacitorNetworkPolicy', :path => '../node_modules/@elizaos/capacitor-network-policy'
```

## Usage

```ts
import "@elizaos/capacitor-network-policy";
// globalThis.ElizaNetworkPolicy is now set (side-effect on import).

import { NetworkPolicy } from "@elizaos/capacitor-network-policy";

// Android
const { metered } = await NetworkPolicy.getMeteredHint();
if (metered === true) { /* skip download */ }

// iOS
const { isExpensive, isConstrained } = await NetworkPolicy.getPathHints();
if (isExpensive || isConstrained) { /* skip download */ }
```

## Build

```bash
bun run --cwd plugins/plugin-native-network-policy build
```

Outputs:
- `dist/esm/index.js` — ESM (TypeScript-compiled)
- `dist/plugin.js` — IIFE for web bundlers
- `dist/plugin.cjs.js` — CommonJS
