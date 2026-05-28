# Technical Implementation

## Static Export

Setting `output: 'export'` in `next.config.ts` outputs static HTML/CSS/JS files. No Node.js server runs at runtime. Required because Capacitor loads files from the device's local filesystem.

### What Breaks in Static Export

| Feature | Used in Feed? | Impact | Mitigation |
|---------|-----------------|--------|------------|
| **API Routes** | ✅ 315 routes | Not included in static export | API stays on Vercel; mobile calls remote API |
| **Middleware** | ✅ CORS, auth gating | Not available | CORS: add Capacitor origins. Auth gating: client-side. |
| **Server Actions** | ✅ 3 files | Cannot call server functions | Converted to API routes ✅ |
| **`headers()` / `cookies()`** | ✅ layout, home page | Not available at runtime | Removed from mobile pages ✅ |
| **`next/image` optimization** | ✅ 15 files | Vercel Image CDN unavailable | Custom loader ✅ |
| **`redirect()` (server)** | ✅ 5 pages | Server redirect unavailable | Client-side `useRouter().replace()` ✅ |
| **`generateMetadata()` with DB** | ✅ 2 pages | Dynamic OG tags impossible | Excluded from mobile ✅ |
| **`force-dynamic` export** | ✅ feed/agents layouts | Incompatible | Removed directive ✅ |
| **Dynamic routes** | ✅ 15 routes | Require `generateStaticParams` | Server/client split with placeholder params ✅ |

### Dynamic Routes Solution

Each dynamic route uses a server/client split:
- `page.tsx` — server component with `generateStaticParams` returning placeholder params
- `client.tsx` — the actual UI with `useParams()`

In-app navigation uses client-side pushState (no file lookup). Deep links are intercepted by `appUrlOpen` before the WebView resolves a file. The only edge case is page refresh on a dynamic route — the placeholder HTML file serves as a shell.

---

## Code Sharing Strategy

The mobile app shares code from `apps/web/src/` via webpack aliases:

```typescript
// apps/mobile/next.config.ts
config.resolve.alias = {
  '@/components': path.join(webSrc, 'components'),
  '@/hooks': path.join(webSrc, 'hooks'),
  '@/stores': path.join(webSrc, 'stores'),
  '@/utils': path.join(webSrc, 'utils'),
  '@/contexts': path.join(webSrc, 'contexts'),
  '@/lib': path.join(webSrc, 'lib'),
  '@/types': path.join(webSrc, 'types'),
  '@web': webSrc,        // for importing web page components
  '@/mobile': mobileSrc, // for mobile-specific code
};
```

`@/app/` is NOT aliased — the mobile app has its own page layer. For importing web page components (re-exports), use `@web/app/...` which doesn't trigger Next.js route discovery.

---

## Key Technical Decisions

### `apiUrl()` utility

Every `fetch('/api/...')` call goes through `apiUrl()` (`apps/web/src/utils/api-url.ts`). When `NEXT_PUBLIC_API_URL` is unset (web), it's a no-op. When set (mobile), it prepends the base URL. This was applied to ~190 fetch call sites across ~150 files, including `apiFetch()`, `useSSE`, `SSEManager`, custom wrappers (`callApi`, `apiCall`), and direct fetch calls.

### Server actions → API routes

3 server action files (`_actions/onchain.ts`, `_actions/nft.ts`, `_actions/utils.ts`) were replaced with API routes:
- `POST /api/onchain` — handles buy-shares, sell-shares, and update-agent-profile through the app API
- `POST /api/nft/mint/execute` — full mint flow (prepare → send tx → poll for confirmation with exponential backoff)
- `GET /api/profiles/resolve/[identifier]` — resolves ambiguous identifiers to canonical profile paths

The 3 calling hooks were rewritten to use `fetch(apiUrl(...))` instead of direct server action imports. Minor web perf regression (~1-5ms) but eliminates the `@/app/_actions` import dependency that would break webpack aliases.

### Device tokens

Push notification device tokens are stored in Redis (not a DB table) — they're ephemeral data that changes when users reinstall. Redis hash per user, 90-day TTL, supports multiple devices per user.

### Native features

All Capacitor plugins are lazy-loaded via dynamic `import()`. This means native feature code is never bundled on web, and native calls are no-ops when `Capacitor.isNativePlatform()` returns false.

---

## File Manifest

### New Files Created

| File | Purpose |
|------|---------|
| `apps/web/src/utils/api-url.ts` | `apiUrl()` utility |
| `apps/web/src/app/api/onchain/route.ts` | On-chain transaction API |
| `apps/web/src/app/api/nft/mint/execute/route.ts` | NFT mint execute API |
| `apps/web/src/app/api/profiles/resolve/[identifier]/route.ts` | Profile resolution API |
| `apps/web/src/app/api/notifications/register-device/route.ts` | Push token registration |
| `apps/web/src/app/api/notifications/unregister-device/route.ts` | Push token removal |
| `apps/web/public/.well-known/apple-app-site-association` | iOS Universal Links |
| `apps/web/public/.well-known/assetlinks.json` | Android App Links |
| `apps/mobile/` | Complete mobile app (77+ files) |
| `apps/mobile/src/components/AppUrlListener.tsx` | App deep-link handler |
| `apps/mobile/src/lib/platform.ts` | Platform detection |
| `apps/mobile/src/lib/haptics.ts` | Haptic feedback |
| `apps/mobile/src/lib/push-notifications.ts` | Push setup |
| `apps/mobile/src/lib/status-bar.ts` | Status bar theming |
| `apps/mobile/src/lib/deep-links.ts` | App lifecycle |
| `apps/mobile/src/lib/native-init.ts` | Native init orchestration |
| `apps/mobile/src/lib/image-loader.ts` | Custom image loader |
| `packages/testing/unit/mobile/` | 46 unit tests |

### Modified Files

~150 files updated with `apiUrl()` for fetch calls, plus SSE fixes, shared code moves, hook rewrites, Providers update, and middleware CORS update.

---

## Remote URL Alternative

Instead of static export, Capacitor can load from a remote URL:

```typescript
const config: CapacitorConfig = {
  server: { url: 'https://play.feed.market' },
};
```

**Pros:** Zero code changes. Full feature parity. Instant updates.
**Cons:** Requires internet. Slower load. Higher Apple rejection risk.
**Use for:** Dev testing, Android Play Store (less strict), internal TestFlight.
