# Implementation Status & Remaining Work

## Progress

| Phase | Status | Details |
|-------|--------|---------|
| Phase 0: PoC | ✅ Complete | Privy verified on Android emulator + Pixel 10 |
| Phase 1a: Web refactors | ✅ Complete | ~190 fetch calls, 3 API routes, shared code moves |
| Phase 1b: Mobile app | ✅ Complete | 39 pages, 41 HTML output, 32MB static export |
| Phase 2: Capacitor integration | ✅ Code complete | AppUrlListener, OAuth config, CORS, deep link files |
| Phase 3: Native features | ✅ Code complete | Haptics, push, status bar, deep links, app icon |
| Phase 4: App Store prep | ❌ Not started | Screenshots, descriptions, signing, legal |
| Phase 5: Submit | ❌ Not started | TestFlight, Play Store, review |

---

## Detailed Checklists

### Phase 0: PoC ✅

- [x] Privy SDK initializes in Capacitor WebView
- [x] Embedded wallet iframe loads without blocking errors
- [x] OAuth redirect flow fires correctly
- [x] Full app renders and navigates on real Pixel 10

### Phase 1a: Web App Refactors ✅

- [x] `apiUrl()` utility (`apps/web/src/utils/api-url.ts`)
- [x] ~190 fetch calls updated across ~150 files
- [x] SSE URL construction fixed (`useSSE.ts`, `SSEManager.ts`)
- [x] Shared code moved out of `app/` directory
- [x] 3 new API routes (`/api/onchain`, `/api/nft/mint/execute`, `/api/profiles/resolve/[identifier]`)
- [x] 3 hooks rewritten to use API routes instead of server actions
- [x] 46 unit tests passing
- [x] Web app typechecks clean, no regressions

### Phase 1b: Mobile App ✅

- [x] `apps/mobile/` with Next.js static export (`output: 'export'`)
- [x] Webpack aliases sharing code from `apps/web/src/`
- [x] `@web/` alias for web page imports without route discovery
- [x] 39 mobile pages (29 re-exported, 10 mobile-specific)
- [x] 13 dynamic routes with server/client split + `generateStaticParams`
- [x] Custom image loader, mobile-specific root layout

### Phase 2: Capacitor Integration ✅ (code complete)

- [x] `capacitor.config.ts` with dev/prod mode support
- [x] All Capacitor plugins in `package.json`
- [x] `AppUrlListener` component for Privy OAuth deep links
- [x] `customOAuthRedirectUrl` passed to Privy via `Providers` prop
- [x] Platform detection utility (`isNativePlatform`, `getPlatform`, `isIOS`, `isAndroid`)
- [x] `apple-app-site-association` + `assetlinks.json` (placeholder IDs)
- [x] CORS origins added to middleware

### Phase 3: Native Features ✅ (code complete)

- [x] Haptic feedback utility
- [x] Push notification client (permission, registration, foreground, tap)
- [x] Push token API routes (Redis-backed, 90-day TTL)
- [x] Status bar theming (dark/light sync, edge-to-edge)
- [x] Android back button handling
- [x] App lifecycle listeners (resume from background)
- [x] Keyboard height CSS variable (`--keyboard-height`)
- [x] Native init orchestration in mobile layout
- [x] App icon (1024×1024 source) + splash screen config
- [x] `@capacitor/assets` generate script

---

## Remaining Work

### Infrastructure (requires external access)

| Item | Needs | Who |
|------|-------|-----|
| `npx cap add ios` | macOS + Xcode | Anyone with a Mac |
| `bun run generate:assets` | Run after `cap add` | Same |
| Privy dashboard: Capacitor allowed origins | Dashboard login | Admin |
| Privy dashboard: OAuth redirect URL | Dashboard login | Admin |
| Vercel: `CORS_ALLOWED_ORIGINS` env var | Vercel dashboard | Admin |
| `apple-app-site-association` TEAM_ID | Apple Developer account | Admin |
| `assetlinks.json` SHA256 | Android signing keystore | Admin |
| iOS `Info.plist` + Android `AndroidManifest.xml` | After `cap add` generates native projects | Dev |
| Firebase project for FCM push delivery | Firebase console | Admin |
| Push sending service | Backend worker or OneSignal | Backend dev |

### Decisions Needed (blocking for App Store)

| Item | Type | Owner |
|------|------|-------|
| Prediction markets — gambling classification? | Legal research | Legal |
| Stripe IAP — use Apple IAP or remove purchases? | Business decision | Product |

### App Store Prep

| Item | Needs | Owner |
|------|-------|-------|
| Screenshots (iPhone + Android) | Device captures | Design |
| Store descriptions + keywords | Copywriting | Marketing |
| Privacy policy | Legal document | Legal |
| Code signing (iOS + Android) | Developer accounts | Admin |
| TestFlight / Play Store internal testing | Build + submit | Dev |

---

## Risk Status

| Risk | Status | Notes |
|------|--------|-------|
| Privy in WebView | ✅ Verified | Tested on emulator + real device |
| CORS blocks API calls | ✅ Fixed in code | Deploy to Vercel pending |
| Fetch calls use relative URLs | ✅ All updated | ~190 calls across ~150 files |
| Server actions in static export | ✅ Converted | 3 API routes created |
| Shared code imports `@/app/` | ✅ Moved | 6 imports resolved |
| Apple rejects as web wrapper | ⚠️ Medium risk | Native plugins provide mitigation |
| Apple rejects for prediction markets | ⚠️ Unknown risk | Legal research needed |
| Cookie auth cross-origin | ⚠️ Low risk | Bearer token fallback exists |
| SSE on mobile | ⚠️ Low risk | Reconnection logic exists, needs testing |
| Stripe in WebView | ⚠️ Unknown | Needs testing + IAP decision |

---

## Dev Setup

### First-time Android setup (inside devcontainer)

```bash
# 1. Install dependencies
bun install

# 2. Initialize the Android project (only needed once)
cd apps/mobile && npx cap add android

# 3. Generate app icons and splash screens
bun run generate:assets

# 4. Build the mobile Next.js app and sync to Android project
bun run mobile:build
```

The `android/` directory will appear in `apps/mobile/android/` on your host
machine via the bind mount — open it directly in Android Studio.

### Android Testing (devcontainer + local Android Studio)

```bash
# --- Inside devcontainer ---
# Start the mobile dev server (port 3077 is forwarded to your host automatically)
cd apps/mobile && bun run dev

# --- On your host machine ---
# Forward device's localhost to host's localhost:3077
# (for physical device connected via USB)
~/Android/Sdk/platform-tools/adb reverse tcp:3077 tcp:3077

# For emulator, use 10.0.2.2 instead of localhost in the config below
```

Set `CAPACITOR_SERVER_URL` in your `.env` (or export it):
```bash
# Physical device (via adb reverse)
CAPACITOR_SERVER_URL=http://localhost:3077

# Android emulator (accesses host via 10.0.2.2)
CAPACITOR_SERVER_URL=http://10.0.2.2:3077
```

Then rebuild and sync:
```bash
# Inside devcontainer
cd apps/mobile && bun run mobile:build
# Open android/ in Android Studio and run the app
```

**Port forwarding chain (physical device):**
```
Android device (localhost:3077)
  → adb reverse →
Host machine (localhost:3077, forwarded from devcontainer)
  → devcontainer port forward →
Devcontainer (localhost:3077 = Next.js mobile dev server)
```

### Production Build

```bash
cd apps/mobile

# Set env vars
NEXT_PUBLIC_API_URL=https://play.feed.market \
NEXT_PUBLIC_PRIVY_APP_ID=<privy-app-id> \
bun run build

# Sync to native projects
npx cap sync

# Generate all icon/splash sizes
bun run generate:assets

# Open in IDE
npx cap open android  # or npx cap open ios
```

### Unit Tests

```bash
cd /path/to/bab
bun test packages/testing/unit/mobile/ --preload ./packages/testing/unit/preload.ts
# 46 tests, 3 test files
```

