# Architecture Analysis

## Codebase Metrics

| Metric | Count | Verified |
|--------|-------|----------|
| API route files (`route.ts`) | **315** | ✅ |
| Page components (`page.tsx`) | **40** | ✅ |
| Client pages (`'use client'`) | **28** (70%) | ✅ |
| Server pages (no directive) | **12** (30%) | ✅ Individually read and categorized below |
| Layout files | **3** | ✅ |
| Server action files (`'use server'`) | **3** | ✅ |
| UI component files | **230** | ✅ |
| Zustand stores | **10** | ✅ |
| Custom hooks | **40+** | ✅ |
| Dynamic routes (`[param]`) | **15** | ✅ |
| Cron jobs (Vercel) | **15** scheduled | ✅ |
| `next/image` usage | **15 files** | ✅ |
| `next/link` usage | **40 files** | ✅ |
| `useRouter` usage | **47 files** | ✅ |
| Direct `fetch('/api/...')` calls (NOT via apiFetch) | **~190 calls** | ✅ |
| `window.location.origin` usage for API URLs | **14 files** | ✅ |

---

## The 12 Server Pages — Detailed Breakdown

Every server page was individually read and categorized:

### Category A — Thin Wrappers (5 pages)

Trivial to convert. Just unwrap params and render a client component.

| File | What It Does | Conversion |
|------|-------------|------------|
| `feed/page.tsx` | Wraps `<FeedClient />` in Suspense | Add `'use client'`, zero logic changes |
| `actors/[id]/page.tsx` | Unwraps params, renders `<ProfilePageClient identifier={id} mode="actor" />` | Add `'use client'`, use `useParams()` |
| `orgs/[id]/page.tsx` | Unwraps params, renders `<ProfilePageClient identifier={id} mode="org" />` | Add `'use client'`, use `useParams()` |
| `u/[handle]/page.tsx` | Unwraps params, renders `<ProfilePageClient identifier={handle} mode="user" />` | Add `'use client'`, use `useParams()` |
| `u/id/[userId]/page.tsx` | Unwraps params, renders `<ProfilePageClient identifier={userId} mode="user_id" />` | Add `'use client'`, use `useParams()` |

### Category B — Server Redirects (3 pages)

Convert server `redirect()` to client-side `useRouter().replace()`.

| File | What It Does | Conversion |
|------|-------------|------------|
| `registry/page.tsx` | Calls `redirect('/admin?tab=registry')` | `useRouter().replace()` in `useEffect` |
| `markets/perps/[ticker]/page.tsx` | Builds query params, calls `redirect('/markets?...')` | `useRouter().replace()` with `useParams` + `useSearchParams` |
| `markets/predictions/[id]/page.tsx` | Builds query params, calls `redirect('/markets?...')` | Same pattern |

### Category C — Server-Side Data Access (2 pages)

Requires new API routes or significant rework.

| File | What It Does | Why It's Hard | Conversion |
|------|-------------|---------------|------------|
| `profile/[id]/page.tsx` | Calls `findUserByIdentifierWithSelect()` from `@feed/api`, queries DB directly (`@feed/db`), loads actors from `@feed/engine`, resolves identifier → redirect to `/u/handle` or `/actors/id` | **Imports 3 server-only packages**, does DB queries at request time, uses `force-dynamic` | Created `GET /api/profiles/resolve/[identifier]` API route. Mobile page calls it and navigates. |
| `page.tsx` (home) | Uses `headers()` for host detection (waitlist vs app), `redirect()` based on NFT gating flag | Uses `next/headers`, `next/navigation` server redirect | Mobile version skips all host/gating logic, renders `<HomePageClient />` directly. Host detection is irrelevant in native app. |

### Category D — OG Meta Tag Pages (2 pages, EXCLUDED)

These pages exist solely for social sharing previews. They use DB queries in `generateMetadata()` at request time, which is impossible in static export. They have no purpose in a native app — OG crawlers don't visit native apps.

| File | What It Does |
|------|-------------|
| `share/pnl/[userId]/page.tsx` | `generateMetadata()` with `db.user.findUnique()`, `runtime = 'nodejs'`, then `redirect('/markets')` |
| `share/referral/[userId]/page.tsx` | `generateMetadata()` with `db.user.findUnique()` + `getOrCreateReferralCode()`, then `redirect()` |

---

## Server-Side Dependencies

| Category | Technology | Mobile Impact |
|----------|-----------|---------------|
| **Database** | PostgreSQL via `drizzle-orm` + `postgres` (Neon) | Server-only; stays on Vercel |
| **Cache/Realtime** | Redis via `ioredis` | Server-only; SSE endpoint stays on Vercel |
| **Auth** | Privy (`@privy-io/server-auth` server, `@privy-io/react-auth` client) | Server validates JWT on Vercel. Privy officially supports Capacitor. OAuth + embedded wallet verified working. |
| **Storage** | Vercel Blob (`@vercel/blob`) | Server-only; upload API stays on Vercel |
| **Analytics** | PostHog (`posthog-node` server, `posthog-js` client) | Client PostHog works in WebView ✅ |
| **Payments** | Stripe server SDK + `@stripe/stripe-js` client | Needs WebView testing. May trigger Apple IAP requirements. |
| **Blockchain** | `viem`, `ethers`, `@solana/kit` | Pure JS — works in WebView ✅ |
| **AI/ML** | OpenAI, Anthropic, Groq, LangChain, Eliza | Server-only; no mobile impact |
| **Monitoring** | Sentry (`@sentry/nextjs`) | Client Sentry SDK works in WebView ✅ |

---

## Client-Side Architecture

- **State management:** Zustand with 10 stores — works in WebView ✅
- **Data fetching:** `apiFetch()` wrapper + ~190 direct `fetch('/api/...')` calls. All updated to use `apiUrl()`.
- **Realtime:** SSE via `SSEManager` singleton. Fixed to use `apiUrl()` instead of `window.location.origin`.
- **Routing:** Next.js App Router with `useRouter` and `next/link` — works in static export ✅
- **Auth:** Privy React SDK (`usePrivy`, `useWallets`) — ✅ Verified in Capacitor
- **Web3:** wagmi + viem — pure JS, works in WebView ✅
- **Styling:** Tailwind CSS 4 + Radix UI — works in WebView ✅

---

## Critical Architecture Findings

### The Fetch Problem (RESOLVED)

All ~190 `fetch('/api/...')` calls across ~150 files have been updated to use `apiUrl()` which prepends `NEXT_PUBLIC_API_URL` when set. Includes single-line patterns, multi-line fetch calls, URL variables, custom API wrappers (`callApi` in usePerpTrade, `apiCall` in interactionStore), ternary URL assignments, and useMemo URL builders.

### CORS (RESOLVED in code)

`capacitor://localhost` (iOS) and `https://localhost` (Android) added to the middleware's CORS allowlist. Pending: set `CORS_ALLOWED_ORIGINS` env var on Vercel production.

### Cookie-Based Auth in Cross-Origin Context (LIKELY OK)

`apiFetch()` sends `credentials: 'include'` for cookies. In cross-origin context, SameSite cookies won't be sent. However, `apiFetch()` also sends `Authorization: Bearer <token>` via `getPrivyAccessToken()`. The API middleware checks both cookie and header. Likely OK but needs explicit production testing.

### Shared Code Imports `@/app/` Paths (RESOLVED)

Six files that imported from `@/app/` were fixed:
- `formatters.ts` moved to `lib/market-formatters.ts`
- Agent create components/hooks moved to `components/agents/create/`
- 3 hooks rewritten to use API routes instead of server action imports

### Server Action Call Sites (RESOLVED)

The 3 server action files were replaced with API routes (`POST /api/onchain`, `POST /api/nft/mint/execute`). The 3 calling hooks (`useOnChainBetting`, `useNftMint`, `useUpdateAgentProfileTx`) were rewritten to use `fetch(apiUrl(...))`.

---

## Architecture Diagram

```
apps/web (Vercel)                  apps/mobile (Capacitor)
┌──────────────┐                   ┌──────────────────┐
│ SSR pages    │                   │ Static pages     │
│ API routes   │◄──── HTTPS ──────►│ (in WebView)     │
│ Cron jobs    │                   │ + Native plugins │
│ Middleware   │                   └──────────────────┘
└──────────────┘                   App Store / Play Store
```

The mobile app shares components, hooks, stores, and utilities from `apps/web/src/` via webpack aliases. It has its own page layer (`apps/mobile/src/app/`) that's client-only for static export. The API stays on Vercel — the mobile app calls it cross-origin via `NEXT_PUBLIC_API_URL`.

