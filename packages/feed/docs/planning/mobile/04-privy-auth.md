# Privy & Authentication in Capacitor

## Verification Status

**✅ Privy OAuth:** Officially documented by Privy for Capacitor. Tested Feb 13 2026 on Android emulator (Pixel 9 API 35) and real device (Pixel 10).

**✅ Privy embedded wallet:** SDK initializes, embedded wallet iframe loads, OAuth redirect fires correctly. The iframe uses `postMessage` for communication (not cookies), making it inherently WebView-compatible.

### What Was Tested

- Privy SDK initializes in Capacitor WebView ✅
- Privy login modal renders correctly ✅
- Embedded wallet iframe loads without blocking errors ✅
- OAuth redirect flow fires correctly (Farcaster → redirected to app store since Warpcast not on emulator, expected behavior) ✅
- No HTTPS / iframe / postMessage errors ✅

### Why Embedded Wallet Works in WebView

Reading the Privy SDK source (`@privy-io/react-auth` v3.13.1):

1. Privy creates a hidden `<iframe>` loaded from Privy's API domain (e.g., `auth.privy.io`)
2. The main page communicates with this iframe via `postMessage` (cross-origin messaging)
3. The access token is passed to the iframe explicitly via `postMessage` — NOT via cookies
4. Wallet signing operations (`signMessage`, `signTypedData`, `sendTransaction`) are performed by calling `walletProxy.rpc()` which sends the request to the iframe with the access token
5. Key recovery (`recoverEmbeddedWallet`) also passes the `accessToken` parameter explicitly

This architecture is WebView-compatible because:
- Cross-origin iframes ARE supported in WKWebView ✅
- `postMessage` works cross-origin in WKWebView ✅
- The iframe receives all auth state via `postMessage`, not via its own cookies/localStorage ✅
- No dependency on third-party cookie access (which Safari/WKWebView blocks via ITP) ✅

---

## Capacitor OAuth Integration

Per Privy's official Capacitor docs, the OAuth integration requires:

1. **Plugins:** `@capacitor/browser` and `@capacitor/app`
2. **`AppUrlListener` component** that intercepts OAuth redirect deep links (checks for `privy_oauth_code`, `privy_oauth_state`, `privy_oauth_provider` params)
3. **`customOAuthRedirectUrl`** in PrivyProvider config pointing to an HTTPS URL on your domain (e.g., `https://feed.market/redirect`)
4. **Universal App Links** (HTTPS URLs) — custom URL schemes do NOT work for OAuth
5. **Privy dashboard:** add `capacitor://localhost` (iOS) and `https://localhost` (Android) as allowed origins
6. **Deep link verification files:** `apple-app-site-association` (iOS) and `assetlinks.json` (Android) served from `/.well-known/`
7. **Platform config:** iOS `Info.plist` URL schemes + Android `AndroidManifest.xml` intent filters

Privy uses `ASWebAuthenticationSession` on iOS and Chrome Custom Tabs on Android — native platform flows, not WebView popups.

### Implementation

**`AppUrlListener`** (`apps/mobile/src/components/AppUrlListener.tsx`):
- Listens for `appUrlOpen` events from Capacitor
- Checks for Privy OAuth params (`privy_oauth_code`, `privy_oauth_state`, `privy_oauth_provider`)
- Injects OAuth params into the current WebView URL so Privy SDK can complete authentication
- Also handles non-OAuth deep links (navigates to the path)
- Must be mounted BEFORE `PrivyProvider` in the component tree

**`customOAuthRedirectUrl`** (`apps/mobile/src/app/layout.tsx`):
- Passed to Privy via the `Providers` component's `privyConfigOverride` prop
- Defaults to `https://feed.market/redirect`
- Configurable via `NEXT_PUBLIC_OAUTH_REDIRECT_URL` env var

---

## CORS

Capacitor's WebView sends requests from `capacitor://localhost` (iOS) or `https://localhost` (Android). These origins are added to the middleware's CORS allowlist in `apps/web/src/middleware.ts`.

**Pending:** Set `CORS_ALLOWED_ORIGINS=capacitor://localhost,https://localhost` on Vercel production environment.

---

## Cookie-Based Auth in Cross-Origin Context

`apiFetch()` sends `credentials: 'include'` to include the `privy-token` httpOnly cookie. In a cross-origin context (Capacitor WebView → Vercel API), SameSite cookies won't be sent.

**Fallback:** `apiFetch()` also sends `Authorization: Bearer <token>` via `getAccessToken()`. The API middleware (`packages/api/src/auth-middleware.ts`) checks both cookie and header — cookie first, then Authorization header.

**Status:** Likely OK because of the Bearer token fallback, but needs explicit production testing.

---

## Privy Login Methods in Feed

From `packages/shared/src/auth/privy-config.ts`:

```
Primary: farcaster, email
Overflow: metamask, twitter, discord, telegram, phantom, rabby_wallet,
          coinbase_wallet, rainbow, backpack
```

All of these use either:
- **Email:** OTP code entry within the Privy modal (works in WebView, no external redirect)
- **OAuth:** External browser redirect via Capacitor's `@capacitor/browser` plugin (Farcaster, Twitter, Discord, Telegram)
- **Wallet:** WalletConnect deep links or browser extension detection (MetaMask, Phantom, etc.)
