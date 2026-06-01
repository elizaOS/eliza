# @elizaos/plugin-phone

Phone integration for elizaOS — Android dialer overlay and iOS Phone Companion.

## What it does

This plugin ships two independent surfaces:

**Android Phone overlay**
A full-screen dialer app (Dialer, Recent Calls, Contacts tabs) that runs as an overlay inside the elizaOS Android shell. It reads call history from the native `READ_CALL_LOG` permission via `@elizaos/capacitor-phone` and exposes it to the agent runtime. Tapping a recent-call or contact row places a call through `Phone.placeCall`. The Contacts tab is shown only when `@elizaos/capacitor-contacts` is available on the device.

**Phone Companion (iOS)**
A three-screen Capacitor surface (Chat, Pairing, Remote Session) that runs inside the main elizaOS iOS bundle. It pairs with a desktop Eliza agent via a QR code scan, mirrors the agent's chat stream, and can relay touch gestures to a remote VNC/noVNC session running on the paired Mac. APNs push notifications can trigger a Remote Session view automatically when enabled.

## Capabilities added to the agent

| Surface | What the agent gains |
|---------|---------------------|
| `phoneCallLog` provider | Read-only Android call history injected into the agent's context for questions about recent calls. Fetches up to 50 entries. Requires `ADMIN` role. Available in `contacts` and `messaging` contexts. |
| `/phone` view | Full-screen dialer overlay (desktop, XR). |
| `/phone/tui` view | Terminal-mode dialer + transcript UI. Supports the `terminal-phone-state`, `terminal-place-call`, `terminal-open-dialer`, `terminal-save-call-transcript` capabilities via `interact()`. |
| `/phone-companion` nav tab | iOS companion surface (pairing, chat-mirror, remote-session). |

## Enabling the plugin

```ts
import { appPhonePlugin } from "@elizaos/plugin-phone";

// Pass to the elizaOS runtime plugin list:
const runtime = new AgentRuntime({
  plugins: [appPhonePlugin],
  // ...
});
```

The Android overlay registers automatically when the host is the elizaOS Android shell (`isElizaOS()` returns true). The Phone Companion page registers unconditionally for iOS and desktop hosts.

## Required permissions (Android)

The native `@elizaos/capacitor-phone` plugin requires `READ_CALL_LOG` and `CALL_PHONE` permissions in the host APK's `AndroidManifest.xml`. The plugin surface renders correctly without these permissions, but call-log and call-placement features will fail at runtime.

## Environment / config

All configuration variables are Vite build-time env vars for the companion surface. They do not affect the Android overlay or the agent-side provider.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_ELIZA_AGENT_URL` | — | Pre-configured agent ingress URL shown in the companion Chat view before pairing |
| `VITE_ELIZA_APNS_ENABLED` | `"0"` | Set to `"1"` to enable APNs push registration on iOS |
| `VITE_ELIZA_LOG_LEVEL` | — | Log level for the companion surface |

## Building

```bash
bun run --cwd plugins/plugin-phone build
```

The build produces three outputs: `dist/index.js` (main ESM bundle), `dist/views/bundle.js` (plugin view bundle loaded by the elizaOS view registry), and `dist/index.d.ts` (type declarations).

## Native dependencies

- `@elizaos/capacitor-phone` — Android dialer and call-log native bridge (workspace package).
- `@capacitor/push-notifications` — APNs push registration for the iOS companion.
- `@capacitor/haptics` — Haptic feedback on companion navigation transitions.
- `@capacitor/preferences` — Navigation stack persistence for the companion.
- `@capacitor/barcode-scanner` — QR pairing scan in the companion Pairing view.
- `@elizaos/capacitor-contacts` — Optional contacts bridge (soft-imported at runtime; tab is hidden if unavailable).
