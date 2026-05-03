# Auth Roadmap — Steward + Elizacloud

Three outstanding auth items, scoped with effort and dependencies. Read this before firing workers.

## Current state baseline

- Steward access token = 15m, refresh token = 30d (standard JWT pattern)
- Refresh flow lives in `packages/lib/providers/StewardProvider.tsx` (elizacloud) and `StewardAuth.refreshSession()` (SDK)
- `/auth/providers` endpoint reports: passkey, email, siwe, google, discord, twitter
- Elizacloud login UI exposes: email + passkey only. Not SIWE, not OAuth.
- 269 users have wallet-only Privy accounts and cannot log in
- Silent-logout fix `17dcc955` + login-page refresh recovery `fbaa834a` deployed, but Shadow reports still getting logged out

---

## Problem 1: 15-min logout (TOP PRIORITY — existing users affected)

### Symptom
User signs in, comes back after idle period, gets bounced to /login. Supposed to be transparently refreshed.

### What's actually supposed to happen
1. Access token (15m) expires
2. `StewardProvider` has a `setInterval` refresh check + visibilitychange listener
3. When check fires and token is near expiry, `auth.refreshSession()` runs
4. Refresh uses 30-day refresh token from localStorage, gets new access token
5. New token synced to httpOnly cookie via `POST /api/auth/steward-session`
6. User never notices

### Suspected break points (in priority order)

**A. No refresh token in localStorage**
- Possible if user's session predates refresh token support
- Possible if user cleared storage / incognito
- **Diagnosis**: need Shadow to check `localStorage.getItem('steward_refresh_token')` on repro. Asked, no answer yet.

**B. Refresh endpoint returning non-200 → SDK scorched-earth signout**
- `StewardAuth.refreshSession()` in SDK calls `this.signOut()` on ANY `!res.ok` response — wipes tokens, user fully logged out
- A transient 500 / network blip / CORS hiccup = permanent logout
- **Fix**: distinguish transient failures (5xx, network) from real invalid-token (401). Only signOut on 401.

**C. Client-side refresh loop not running for the user**
- The `useEffect` that runs the refresh check has deps `[isAuthenticated, user]`. If those are stable, the effect persists. But if `user` identity flickers (e.g. re-render with different object reference), effect tears down/recreates and could miss timings.
- Also: `setInterval` is throttled in background tabs. Mitigated by visibilitychange listener, but between expiry and return-to-tab, cookie is already expired and server will 401.

**D. httpOnly cookie expires before client can refresh**
- Access-token cookie is set with no explicit expiry per `fbaa834a` — browser treats as session cookie?
- Middleware reads cookie, sees expired, redirects to /login BEFORE client JS gets a chance to refresh
- **Fix candidates**: server-side refresh on middleware (big refactor), OR store refresh token in second httpOnly cookie and have middleware use it on access-token-expiry.

### Proposed fix (incremental, smallest first)

**Phase 1 — instrument + data gather** (30 min)
- Add client-side logging: timestamp each `checkAndRefresh` call, log whether refresh succeeded, log token TTL at each check
- Add server-side logging on `/auth/refresh`: log every call with outcome (success / 401 / 500)
- Deploy to prod, wait for Shadow to reproduce, look at logs
- **Decision gate**: we'll know which of A/B/C/D is actually happening

**Phase 2 — stop scorched-earth signouts** (1h)
- Patch `StewardAuth.refreshSession()` in SDK: only signOut on 401 (explicit invalid token). For 5xx, network errors, timeouts → return null without clearing state so next tick retries
- Bump SDK to 0.7.4
- Bump react to 0.6.8 (consumes)
- Publish + deploy elizacloud

**Phase 3 — server-side refresh on middleware** (if still broken after Phase 2, ~half day)
- Store refresh token in httpOnly cookie alongside access token
- Middleware, on expired access token + valid refresh token cookie: call `/auth/refresh` server-side, set new access token cookie, proceed
- This is the "real" fix — user never sees a login page for refresh-token-still-valid case
- Risk: adds round-trip to every middleware invocation for expired-access cases
- Reference plan already exists in this repo's docs (SIWE_INTEGRATION_PLAN.md mentions it was deferred)

### Effort estimate
- Phase 1: 30 min
- Phase 2: 1-2h (including SDK republish)
- Phase 3: 4-6h if needed

### Risk
Medium. Refresh logic is the most sensitive part of the auth stack. Needs careful testing. Can break everyone's session if we ship wrong.

---

## Problem 2: Wallet login (SIWE) for stranded Privy users

### Why
269 elizacloud users exist with wallet-only Privy accounts (95 active in 90d, 24 in 30d, 266 have active API keys). They cannot currently log in via Steward.

### Good news
Steward backend + SDK + React provider have SIWE fully implemented. `siwe@3.0.0` in deps. `GET /auth/nonce` + `POST /auth/verify` work. `StewardAuth.signInWithSIWE()` ships in SDK. Full audit in `docs/SIWE_INTEGRATION_PLAN.md`.

### What needs to ship

**Server (steward-fi)** — 4 small changes to `/auth/verify`:
1. **Upsert into `users` table** on SIWE success — currently only creates tenant, leaves `users` empty. Downstream consumers get empty `userId` in JWT.
2. **Include `userId` in JWT** via `createSessionToken(address, tenantId, { userId })`
3. **Lowercase the address** on insert (prevents EIP-55 vs lowercase case-mismatch bug)
4. **Optional: domain allowlist** via `SIWE_ALLOWED_DOMAINS` env var (prevents phishing replay)

**Elizacloud side**:
1. Add wallet connect button to `app/login/steward-login-section.tsx`
   - Minimal wagmi setup (or direct `window.ethereum` for v0)
   - Call `auth.signInWithSIWE(address, signer.signMessage.bind(signer))`
2. Patch `packages/lib/steward-sync.ts` `syncUserFromSteward` to handle wallet-only sessions:
   - New "section 4": if JWT has `address` but no `email` or `userId`, look up `users` by `wallet_address.toLowerCase()`
   - If Privy wallet user exists → link `stewardUserId` to it (269 users automatically migrate)
   - If not → create new Steward-only user

### Effort estimate
- Server: 2h (including tests)
- Elizacloud UI: 2-3h (wagmi or minimal ethereum direct)
- Sync code: 1h
- Total: ~half day

### Risk
Low. SIWE backend already battle-tested via direct API calls. Main risk is wallet-connect library weight + UX polish. Ship with `window.ethereum` direct v0, add wagmi/rainbowkit later.

---

## Problem 3: GitHub OAuth

### Why
Natural fit for an agent platform — GH OAuth = "log in with your dev identity". Builders often don't want to share personal email.

### Current state
- `packages/auth/src/oauth.ts:60` has `BUILT_IN_PROVIDERS = ["google", "discord", "twitter"]` — GitHub NOT in list
- `getEnabledProviders()` checks env for google/discord/twitter only
- `getProviderConfig()` switch has no github case
- Existing test `oauth.test.ts:26` explicitly asserts `isBuiltInProvider("github") === false`

### What needs to ship

**Server (steward-fi)** — ~20 lines:
1. Add `"github"` to `BUILT_IN_PROVIDERS` tuple
2. Add env var check in `getEnabledProviders()`:
   ```ts
   if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) enabled.push("github");
   ```
3. Add `case "github"` to `getProviderConfig()`:
   ```ts
   authorizationUrl: "https://github.com/login/oauth/authorize",
   tokenUrl: "https://github.com/login/oauth/access_token",
   userInfoUrl: "https://api.github.com/user",
   scopes: ["read:user", "user:email"],
   ```
4. `getUserInfo` normalization already handles flat shape. BUT: GitHub doesn't return email in the primary endpoint unless `user:email` scope + email is public. May need secondary call to `https://api.github.com/user/emails` to get primary verified email.
5. Add `github: boolean` to `StewardProviders` type in SDK
6. Update the `/auth/providers` route to report github flag
7. Flip `oauth.test.ts:26` assertion to expect true
8. Add GitHub test case to getUserInfo normalization tests

**Elizacloud side**:
1. Add "Sign in with GitHub" button in login page (if other OAuth buttons don't exist yet, this might be the first one wired)
2. OAuth callback handling — reuse existing `/auth/callback/oauth` route if it exists, else add it

**DevOps**:
1. Register GitHub OAuth app at https://github.com/settings/developers
2. Set callback URL: `https://eliza.steward.fi/auth/callback/github`
3. Add `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` to steward-fi Railway env

### Effort estimate
- Server + SDK: 1.5h
- Elizacloud UI (first OAuth button): 1-2h
- GH app setup + env: 15 min
- Total: ~3-4h

### Risk
Low. GitHub OAuth is well-understood. Only real gotcha is the email-fetch dance. The existing OAuth plumbing is solid.

---

## Dependencies + ordering

```
Problem 1 (15-min logout) ──┬── blocks nothing, but MUST ship first (existing users affected)
                            │
Problem 2 (SIWE) ───────────┴── parallel to Problem 3, but sync code in elizacloud is shared
                                 (syncUserFromSteward changes for both — coordinate in one PR)

Problem 3 (GitHub OAuth) ──── parallel to Problem 2
```

## Proposed execution plan

### Week 1 (this week)
1. **Day 1 — Problem 1 Phase 1**: add instrumentation, deploy, wait for repro
2. **Day 1 — Problem 1 Phase 2**: patch SDK refresh to not scorched-earth, publish SDK 0.7.4 + react 0.6.8, deploy elizacloud
3. **Day 2 — Problem 2 + Problem 3 server-side**: single steward-fi PR adds SIWE user upsert + GitHub provider. Combines audit scope.
4. **Day 2/3 — Elizacloud UI**: wallet button + GitHub button + shared syncUserFromSteward changes in one elizacloud PR

### Week 2 (if needed)
5. **Problem 1 Phase 3** (server-side refresh) if users still getting logged out after Phase 2

## Worker assignment (when you say go)

| Task | Model | Scope |
|------|-------|-------|
| Instrumentation (1 Phase 1) | 5.4 | Add logging, deploy, ~30 min |
| SDK refresh hardening (1 Phase 2) | 5.4 | Patch + publish, ~2h |
| Server-side SIWE + GitHub (2+3 server) | 5.4 | ~3h |
| Elizacloud UI (2+3 client) | Opus 4.7 | ~3h (needs taste) |
| Sync code (2+3 glue) | 5.4 | ~1h |

Total wall-clock if parallel: ~half day for Problems 2+3. Problem 1 is gated on repro data.

## Open questions for Shadow

1. **Did you check localStorage on the last signout?** Need `steward_session_token` + `steward_refresh_token` presence.
2. **Is wagmi acceptable as a dep** in elizacloud, or keep it `window.ethereum` direct? (affects bundle size ~30kb)
3. **GH OAuth scope** — just `read:user + user:email`, or also `repo` for future agent permissions?
4. **Priority call** — which problem first? (Recommend 1, but 2 has the stranded-users urgency.)
