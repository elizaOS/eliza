# @elizaos/capacitor-websiteblocker

A Capacitor plugin that enforces website blocking across browser, Android, and iOS from a single TypeScript API. Used inside elizaOS Eliza app shells.

## What it does

- **Browser / web:** Delegates all blocking operations to the Eliza runtime HTTP API (`/api/website-blocker`).
- **Android:** Runs a foreground split-tunnel VPN service that intercepts DNS queries and blocks the configured hostnames system-wide. Blocking survives device reboot via a `BroadcastReceiver`.
- **iOS:** Manages a native Safari content-blocker extension. Block rules are written to a shared App Group `UserDefaults` store and reloaded via `SFContentBlockerManager`.

## Capabilities

| Method | Description |
|---|---|
| `WebsiteBlocker.getStatus()` | Returns blocker state: `active`, `websites`, `engine`, permission status, `endsAt` |
| `WebsiteBlocker.startBlock(options)` | Starts blocking. Accepts `websites: string[]`, optional `durationMinutes`, optional `text` (hostnames extracted from free text) |
| `WebsiteBlocker.stopBlock()` | Removes block state and shuts down the active blocker |
| `WebsiteBlocker.checkPermissions()` | Returns current permission status without prompting the user |
| `WebsiteBlocker.requestPermissions()` | Triggers the platform consent flow (VPN dialog on Android; Settings redirect on iOS) |
| `WebsiteBlocker.openSettings()` | Opens VPN settings (Android) or Safari Extensions settings (iOS) |

## Installation

```bash
npm install @elizaos/capacitor-websiteblocker
npx cap sync
```

This package is a Capacitor plugin, not a standalone elizaOS runtime plugin. It must be consumed from a Capacitor app that embeds an Eliza agent.

## Platform requirements

### iOS

- iOS 15.0+
- A Safari Content Blocker extension target sharing the same App Group entitlement (`group.<bundleId>`).
- The user must enable the extension in **Settings > Safari > Extensions** before blocking takes effect. `startBlock` saves state but returns `success: false` (with a descriptive message) until the extension is enabled.

### Android

- Android VPN consent is required before the first block. `startBlock` triggers the system VPN permission dialog automatically if consent has not been granted.
- The plugin's `AndroidManifest.xml` already declares the required permissions and service binding:
  - `android.permission.FOREGROUND_SERVICE` / `android.permission.FOREGROUND_SERVICE_SPECIAL_USE`
  - `android.permission.POST_NOTIFICATIONS`
  - `android.permission.RECEIVE_BOOT_COMPLETED`
  - `BIND_VPN_SERVICE` on `WebsiteBlockerVpnService`

### Browser / web

- Requires the boot-config `apiBase` (`window.__ELIZAOS_APP_BOOT_CONFIG__`) and optionally `window.__ELIZA_API_TOKEN__` (or `sessionStorage.eliza_api_token`) to be set by the app shell so the plugin can reach the Eliza runtime API.

## Usage

```typescript
import { WebsiteBlocker } from "@elizaos/capacitor-websiteblocker";

// Check current state
const status = await WebsiteBlocker.getStatus();

// Block sites for 30 minutes
const result = await WebsiteBlocker.startBlock({
  websites: ["x.com", "reddit.com"],
  durationMinutes: 30,
});

// Remove block
await WebsiteBlocker.stopBlock();
```

## Notes

- Blocking `x.com` or `twitter.com` automatically expands to the full set of related subdomains (`mobile.x.com`, `t.co`, CDN domains, etc.) and allowlists API endpoints.
- Hostnames are normalized: protocols and paths are stripped, hostnames without a dot are rejected.
- `durationMinutes` can be a number or a numeric string. Omit or pass `null` for an indefinite block.

