# Native Features

All native features are implemented in `apps/mobile/src/lib/`. They lazy-load Capacitor plugins via dynamic `import()` and are no-ops on web.

## Initialization

`native-init.ts` is the single entry point. Called once from the mobile layout on mount. It sets up:

- Status bar theming (synced with app theme)
- Android back button handling
- App lifecycle listeners
- Keyboard height tracking

The mobile layout also observes theme changes via `MutationObserver` on the `<html>` element's `class` and `data-theme` attributes, and calls `updateTheme()` to keep the status bar in sync.

---

## Haptic Feedback

**File:** `haptics.ts`

Wraps Capacitor's `@capacitor/haptics` plugin:

| Function | Use Case |
|----------|----------|
| `tapLight()` | Button presses, toggles, selections |
| `tapMedium()` | Successful actions (placing a trade, sending a message) |
| `tapHeavy()` | Significant events (minting an NFT, completing onboarding) |
| `notifySuccess()` | Confirmed trades, successful transactions |
| `notifyWarning()` | Approaching limits, low balance |
| `notifyError()` | Failed transactions, validation errors |
| `selectionChanged()` | Scrolling through lists, picker changes |

All functions are fire-and-forget. No-ops on web.

**Integration points** (where to call these in components):
- `tapLight()` — Like button, follow button, tab switches, bottom nav taps
- `tapMedium()` — Post created, comment submitted, trade placed
- `tapHeavy()` — NFT minted, agent created, on-chain registration
- `notifySuccess()` — Trade confirmed, transaction receipt
- `notifyError()` — Trade failed, insufficient balance
- `selectionChanged()` — Market list scrolling, leaderboard pagination

---

## Push Notifications

**Files:** `push-notifications.ts`, plus API routes in `apps/web/`

### Client Setup

`initPushNotifications()` handles:
1. Request permission from OS
2. Register for push tokens (APNs on iOS, FCM on Android)
3. Send device token to `POST /api/notifications/register-device`
4. Listen for foreground notifications
5. Handle notification tap → navigate to relevant screen

`unregisterPushNotifications()` removes device tokens on logout via `POST /api/notifications/unregister-device`.

### Server Setup

Device tokens stored in Redis:
- Key: `push:device:{userId}` (hash)
- Field: the token string (deduplicates multiple registrations)
- Value: JSON with `platform`, `token`, `updatedAt`
- TTL: 90 days (stale tokens expire when users reinstall)
- Supports multiple devices per user

### What's Still Needed

- **Firebase project** for Android FCM push delivery
- **APNs certificate** for iOS push delivery
- **Push sending service** — reads tokens from Redis, sends via FCM/APNs. Options: Firebase Cloud Messaging, OneSignal, custom Vercel cron/worker.

---

## Status Bar

**File:** `status-bar.ts`

| Function | What It Does |
|----------|-------------|
| `setStatusBarStyle(theme)` | Sets light/dark text color. On Android, also sets background color. |
| `enableEdgeToEdge()` | Makes status bar overlay content (Android). iOS does this by default. |

The mobile layout auto-syncs the status bar with the app theme by observing DOM class/attribute changes.

---

## Deep Links & App Lifecycle

**File:** `deep-links.ts`

| Listener | Behavior |
|----------|----------|
| Android back button | `window.history.back()` if history exists, otherwise `App.minimizeApp()` |
| App state change | Logs resume from background (hook for future data refresh logic) |

OAuth deep links (Privy) are handled separately by `AppUrlListener` — see [04-privy-auth.md](./04-privy-auth.md).

---

## Platform Detection

**File:** `platform.ts`

| Function | Returns |
|----------|---------|
| `isNativePlatform()` | `true` if running in Capacitor shell |
| `getPlatform()` | `'ios'`, `'android'`, `'web'`, or `'ssr'` |
| `isIOS()` | Shorthand |
| `isAndroid()` | Shorthand |

Detection priority:
1. `window.Capacitor.isNativePlatform()` (injected by native shell)
2. Origin scheme: `capacitor://` → iOS
3. Origin `https://localhost` + Android user agent → Android
4. Fallback: `web`

Results are cached after first detection.

---

## App Icon & Splash Screen

**Source files:**
- `apps/mobile/resources/icon-only.png` — 1024×1024 app icon source
- `apps/mobile/resources/icon-foreground.png` — Foreground for adaptive icons

**Capacitor config:**
```typescript
SplashScreen: {
  launchAutoHide: true,
  launchShowDuration: 2000,
  backgroundColor: '#0a0a0a',
  splashFullScreen: true,
  splashImmersive: true,
}
```

**Generate all sizes:** After `npx cap add ios/android`:
```bash
cd apps/mobile && bun run generate:assets
```

This uses `@capacitor/assets` to produce all required icon sizes (mdpi through xxxhdpi for Android, all iOS sizes) and splash screens.

---

## Keyboard Handling

The native init sets up keyboard listeners that track the keyboard height via a CSS variable:

```css
/* Available in any component */
var(--keyboard-height)  /* e.g., '300px' when keyboard is open, '0px' when closed */
```

Use this to adjust layouts when the keyboard opens (e.g., chat input, comment forms).

