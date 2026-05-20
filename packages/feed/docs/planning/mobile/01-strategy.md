# Mobile Strategy & Framework Decision

## Goal

Ship Babylon (`apps/web`) — a Next.js 16 full-stack prediction market app — as native iOS and Android apps via the App Store and Google Play, **without** an 80% React Native rewrite.

## Approach

**Capacitor** wrapping a statically-exported Next.js frontend, with the existing Vercel deployment serving as the API backend.

### Why This Works

- The Babylon frontend is ~70% client components (28/40 page files are `'use client'`). The server-side footprint in the _page layer_ is limited to 12 pages, most of which are thin param-unwrapping wrappers.
- The heavy server logic (315 API route files, 15 cron jobs, Redis SSE, database queries) is already architecturally separated behind `/api/*` routes. The client talks to the server via HTTP fetch — a REST-over-HTTP pattern, not tight coupling.
- Capacitor runs your static HTML/CSS/JS inside a native WebView with access to native APIs via plugins. Your React + Tailwind + Radix UI components work as-is.

### What This Does NOT Require

- ❌ Rewriting any React components
- ❌ Abandoning the monorepo
- ❌ Migrating away from Privy, wagmi, viem, or any existing dependency
- ❌ Rewriting the API layer — it stays as Next.js API routes on Vercel

### What This DOES Require

- ✅ Creating a separate Next.js app target with `output: 'export'` for mobile builds
- ✅ Refactoring 12 server-only page components for client-only rendering
- ✅ Replacing `next/image` with a custom image loader (15 files)
- ✅ Making server actions call the API instead of importing server packages directly (3 files)
- ✅ Centralizing ALL fetch calls through a base-URL-aware utility (~190 calls across ~150 files)
- ✅ Adding Capacitor's origin to the CORS allowlist on the API server
- ✅ Integrating Privy's official Capacitor OAuth flow

---

## Framework Comparison

### Capacitor (Ionic)

| Aspect | Assessment |
|--------|-----------|
| **Maturity** | Production-ready. Used by Burger King, Priceline, many Web3 apps |
| **Mobile support** | First-class iOS + Android. This is its entire purpose |
| **Rendering** | WebView-based. HTML/CSS/JS runs inside a native app shell |
| **Plugin ecosystem** | 1700+ plugins. Push notifications, camera, biometrics, haptics, IAP, deep links, status bar, splash screen |
| **Web3 compatibility** | WebView supports WalletConnect deep links, pure-JS crypto libs (viem, ethers). Privy embedded wallets **verified working** (Feb 13 2026) |
| **Static export** | Requires static HTML/CSS/JS. Works with Next.js `output: 'export'` |
| **Bundle size** | App shell ~2-5MB + web bundle. Typical total: 15-40MB |
| **Performance** | Adequate for content/trading apps. Not for 60fps animation-heavy UIs |
| **OTA updates** | Capgo or Capacitor Live Update — update JS bundle without App Store review |

**Verdict: Best fit.**

### Tauri 2.0

| Aspect | Assessment |
|--------|-----------|
| **Maturity** | Tauri 2.0 stable since late 2024. Mobile support functional but younger |
| **Mobile support** | iOS + Android via v2. Fewer production mobile apps |
| **Plugin ecosystem** | Significantly smaller than Capacitor. Lacks IAP, robust push notification plugins |
| **Web3 compatibility** | Largely untested in mobile Web3 context |
| **Rendering** | Same system WebView as Capacitor on mobile — no performance advantage |
| **Build requirements** | Requires Rust toolchain |
| **OTA updates** | No official mechanism |

**Verdict: Not recommended.** Same WebView on mobile, smaller plugin ecosystem, higher complexity from Rust, no OTA updates.

### React Native / Expo

| Aspect | Assessment |
|--------|-----------|
| **Performance** | Best (native rendering) |
| **Code reuse** | ~20-40%. Different primitives (`<View>` not `<div>`), different styling, different navigation |
| **Migration effort** | 80%+ rewrite |

**Verdict: Rejected.** 80%+ rewrite.

### PWA

**Verdict: Cannot be distributed on iOS App Store.** Not viable.

### Comparison Matrix

| Factor | Capacitor | Tauri 2.0 | React Native | PWA |
|--------|-----------|-----------|--------------|-----|
| Code reuse with existing app | **95%+** | **95%+** | **20-40%** | **100%** |
| iOS App Store | ✅ | ✅ | ✅ | ❌ |
| Plugin ecosystem (mobile) | **Excellent** | Fair | Excellent | N/A |
| Push notifications | ✅ Native | ⚠️ Limited | ✅ Native | ⚠️ |
| In-App Purchases | ✅ Plugin | ❌ | ✅ | ❌ |
| OTA Updates | ✅ Capgo | ❌ | ✅ CodePush | ✅ |
| Learning curve | **Low** | High (Rust) | High | **Lowest** |
| Risk | Low-Medium | Medium | Low | High |

