# SIWE Integration Plan — Steward

> **TL;DR — Surprise finding:** SIWE is already fully implemented end-to-end in Steward. Server endpoints (`/auth/nonce`, `/auth/verify`), SDK method (`signInWithSIWE`), React provider hook, and provider discovery flag (`siwe: true`) all exist and ship in current versions (`@stwd/sdk@0.7.2`, `@stwd/react@0.6.6`, `@stwd/api@0.3.0`). The `siwe` npm package (v3.0.0) is already in the dep tree. **Eliza-cloud is not blocked on Steward; it is blocked on its own login UI not exposing SIWE and on its sync code not handling wallet-only sessions.**
>
> The "official" Steward login widget (`StewardLogin` from `@stwd/react`) renders the SIWE button as **disabled** with a placeholder note ("requires wallet integration"). Eliza-cloud doesn't use `StewardLogin` anyway — it has its own `steward-login-section.tsx` and would need a wallet-connected button there.

---

## Current State

### What SIWE-adjacent code already exists in Steward

**Server (`packages/api`, v0.3.0):**

- `packages/api/src/routes/auth.ts:751-833` — full SIWE flow implemented:
  - `GET /auth/nonce` (line 757): returns `{ nonce }`, stores in `nonceStore` Map with 5-min TTL
  - `POST /auth/verify` (line 776): parses `SiweMessage`, validates nonce, calls `siweMessage.verify({ signature })`, auto-creates a tenant per wallet address (`t-<addr[2:10]>`), mints JWT + refresh token
- `packages/api/src/routes/auth.ts:68` — `import { generateNonce, SiweMessage } from "siwe"`
- `packages/api/src/routes/auth.ts:251-263` — in-memory `nonceStore` with periodic cleanup
- `packages/api/src/services/context.ts:97-110` — duplicate exported `nonceStore` (looks like an older copy that was migrated; the route uses its own local one — minor cleanup item)
- `packages/api/src/routes/auth.ts:1407-1416` — `GET /auth/providers` returns `siwe: true` unconditionally
- `siwe@3.0.0` is pinned in `bun.lock`; depends on `@spruceid/siwe-parser` and `ethers ^5 || ^6` (peer)

**SDK (`@stwd/sdk@0.7.2`):**

- `packages/sdk/src/auth.ts:7` — module header lists SIWE as a first-class supported flow
- `packages/sdk/src/auth.ts:520-606` — `StewardAuth.signInWithSIWE(address, signMessage)`:
  1. `GET /auth/nonce`
  2. Builds an EIP-4361 message string locally (domain = `window.location.host` or `"steward.fi"`, chain ID hardcoded to `1`)
  3. Calls the caller-supplied `signMessage` callback (compatible with viem `walletClient.signMessage`, ethers `signer.signMessage`, etc.)
  4. `POST /auth/verify`, stores token + refresh token via existing `storeAndReturn` plumbing
- `packages/sdk/src/auth-types.ts:119` — `siwe: boolean` in `StewardProviders`

**React (`@stwd/react@0.6.6`):**

- `packages/react/src/provider.tsx:150-162` — `signInWithSIWE` exposed via `StewardProvider` context
- `packages/react/src/types.ts:320-326` — typed in the context value
- `packages/react/src/components/StewardLogin.tsx:294-307` — **the built-in widget renders the SIWE button as `disabled={true}` with a "requires wallet integration" tooltip and no onClick handler.** This is the only place that's deliberately incomplete: the widget doesn't ship a wagmi/RainbowKit dep, so it leaves wallet wiring to the consumer.

### How "Farcaster SIWF" was implemented

**It wasn't.** I grepped the entire repo (`packages/**/*.ts(x)`) for `farcaster`, `siwf`, `frame` — zero hits except a coincidental "framework-agnostic" comment. The user-message context's claim that "Steward already supports Farcaster SIWF" appears to be **incorrect**, or it lives somewhere outside this repo (Babylon's own backend?). For Babylon's parallel use case, this is worth flagging back to Shadow.

The closest analogue we have is the SIWE flow itself — which is already a "verify a signed payload, mint a session" pattern, exactly what we'd want to replicate if we ever do add Farcaster.

### Whether Steward's user model supports wallet identity

Yes, in two distinct places:

1. **`tenants.owner_address`** (`packages/db/src/schema.ts:76`) — every SIWE login auto-creates (or looks up) a tenant keyed by wallet address. So Steward already has a 1:1 wallet→tenant mapping for any SIWE user that has logged in.
2. **`users.wallet_address`** (`packages/db/src/schema-auth.ts:24`) — nullable column on the central users table. Currently the SIWE `/verify` endpoint **does not insert into `users`** for SIWE-only sessions; it only creates a tenant. The verify route at `auth.ts:858-859` queries for `users.wallet_address === address` and falls back to `tenant.id` as the refresh-token's `userId`:

   ```ts
   const [siweUser] = await db.select().from(users).where(eq(users.walletAddress, address));
   const siweUserId = siweUser?.id ?? tenant.id;
   ```

   **This is the one real gap for our use case.** A SIWE-only user has no row in `users`, so the JWT issued by `createSessionToken(address, effectiveTenantId)` (line 855) carries `address` and `tenantId` but **no `userId` and no `email`**. Eliza-cloud's `verifyStewardTokenCached` will return `{ userId: "", address, tenantId }` (the `??` fallback in `extractClaims`, `packages/lib/auth/steward-client.ts:97`), and `usersService.getByStewardId("")` will fail to find anything, which then triggers `syncUserFromSteward({ stewardUserId: "" })` — which would happily create a junk user keyed by an empty steward ID.

   So: the JWT payload from a SIWE login is partially functional but would break eliza-cloud's sync without small server-side and client-side fixes (see Proposed Implementation).

### Address normalization gotcha

- Steward stores `tenants.owner_address` and queries `users.wallet_address` using the value `siweMessage.address` returns, which is the **EIP-55 checksum** form (mixed case) — see `auth.ts:800` and `auth.ts:858`. No `.toLowerCase()` anywhere in the SIWE path.
- Eliza-cloud stores `users.wallet_address` lowercase and looks up by `.toLowerCase()` (`packages/db/repositories/users.ts:223,330`; `packages/lib/privy-sync.ts:295` — `walletAddress = account.address.toLowerCase()`).
- **This is a real mismatch.** If we map a SIWE JWT to an existing Privy user purely on `wallet_address`, the comparison will fail unless one side normalizes. Cheap fix: lowercase in `syncUserFromSteward` before lookup (it already does this at `steward-sync.ts:196`). But on the Steward side, if any future code joins on `users.wallet_address`, both writers need to agree — recommendation is to **lowercase on insert in Steward** (one-line change) so the DB invariant is uniform.

---

## Proposed Implementation

### Server-side (steward-fi)

**Almost nothing new needed.** The endpoints exist. Concrete required changes are small:

1. **`packages/api/src/routes/auth.ts:776-832` — `/auth/verify`:**
   - **Add user upsert**: when a SIWE login succeeds and no `users` row exists for the address, insert one (`{ walletAddress: address.toLowerCase(), email: null, emailVerified: false }`). Mirror the pattern in passkey/email routes.
   - **Add `userId` to the JWT** (`createSessionToken(address, effectiveTenantId, { userId })` instead of just `(address, effectiveTenantId)`). Required so downstream consumers (eliza-cloud) can use `payload.userId` as a stable identity.
   - **Lowercase `address` before storing in `tenants.owner_address` and `users.wallet_address`.** Single line, prevents the case-mismatch class of bug forever.
   - **Optional but worth doing now:** validate `siweMessage.domain` against an allowlist (env var, e.g. `SIWE_ALLOWED_DOMAINS=cloud.eliza.how,babylon.market,steward.fi`). Without this, a phisher who tricks the user into signing on `evil.com` could replay against our nonce service. The `siwe` library exposes `domain` after `verify()`.

2. **`packages/db/src/schema-auth.ts`** — no schema changes needed. `users.wallet_address` already exists and is nullable. **However**, recommend adding a `uniqueIndex("users_wallet_address_unique")` on `LOWER(wallet_address)` to prevent two SIWE users colliding from concurrent first-time logins. (Current `users.email` already has `.unique()` — wallet should match.)

3. **Move `nonceStore` to Redis** (or at least to the existing `tokenStore` backend infrastructure). Currently it's an in-memory `Map`, which is fine for a single-instance dev server but breaks horizontally: nonce issued by instance A, verify request goes to instance B → "Invalid nonce". The codebase already has `initAuthStores()` and Redis plumbing (`packages/api/src/middleware/redis.ts`); reuse it. **Required for production.**

4. **Tenant auto-creation policy.** Right now, every new wallet that signs in creates a brand-new tenant named `t-<8hexchars>`. For our use case (eliza-cloud users authenticating into the existing `elizacloud` tenant), this is wrong — we want them to land in the requesting tenant, not get a personal one. The route partially handles this via the `X-Steward-Tenant` header (line 845-852), but the auto-creation still happens unconditionally. **Recommended change:** if `X-Steward-Tenant` is present and valid, skip the auto-tenant creation entirely and just attach the user to the requested tenant via `userTenants`. (This will also match how email/passkey logins behave.)

5. **`siwe` dep status:** Already in `bun.lock` at v3.0.0 in `packages/api`. It pulls in `ethers` as a peer dep — Steward already has `viem ^2.30` but not `ethers`. Two options:
   - Live with the indirect `ethers` peer (works because `siwe` v3 is happy with either v5 or v6, and the resolver will pick something).
   - Use the lower-level `siwe-parser` and write our own verification with viem's `verifyMessage`. Cleaner long-term, ~30 lines of code, but not blocking. Defer.

### SDK / React side

**Already shipped.** The relevant change is documentation, not code:

- `StewardAuth.signInWithSIWE(address, signMessage)` — works as-is.
- `useSteward().signInWithSIWE(...)` — works as-is.

Optional polish:
- `packages/react/src/components/StewardLogin.tsx:294-307` — wire up the SIWE button properly. Either ship a wagmi-based default OR accept a `walletConnector` prop so consumers can plug in their own (RainbowKit, ConnectKit, Privy-as-wallet-only-mode, raw window.ethereum). Right now this is the only piece that says "todo" in code.
- The SDK message builder hardcodes `Chain ID: 1` (Ethereum mainnet). For most projects (eliza-cloud, Babylon, waifu) this is fine — wallet addresses are chain-agnostic for ECDSA signatures and SIWE doesn't actually authorize anything on-chain. But if we ever want chain-bound sessions (e.g. "you must be on Base to use this"), we'll want to plumb chain ID through. Defer.

### Integration on eliza-cloud

This is where most of the work is. Files & changes:

1. **`packages/lib/auth/steward-client.ts:97`** — `extractClaims` reads `payload.sub ?? payload.userId ?? ""`. Once Steward starts including `userId` in the SIWE JWT, this is fine. **No change required**, but add a defensive log if both `userId` and `email` are empty but `address` is present (signals a SIWE-only session).

2. **`packages/lib/auth.ts:204-232`** — when the steward token is for a SIWE-only user, `stewardClaims.email` will be `undefined`. `syncUserFromSteward` already handles this case (`steward-sync.ts:202` falls back to wallet-derived name). Confirmed safe.

3. **`packages/lib/steward-sync.ts:191-300`** — needs one new branch:
   - **Lookup by `wallet_address` BEFORE creating a new user** when `email` is not provided. This is the "merge legacy Privy wallet user with new Steward identity" path. Pseudocode:
     ```ts
     // After step 1 (lookup by stewardUserId), before step 2 (lookup by email):
     // 1.5 — wallet-only path: if no email and we have a wallet, try to claim
     // an existing user record by wallet_address.
     if (!email && walletAddress) {
       const existing = await usersService.findByWalletAddress(walletAddress);
       if (existing) {
         await usersService.update(existing.id, {
           steward_user_id: stewardUserId,
           updated_at: new Date(),
         });
         await usersService.upsertStewardIdentity(existing.id, stewardUserId);
         return existing;
       }
     }
     ```
   - This is the linchpin: it lets all 269 legacy Privy wallet-only users transition silently. They sign in with their wallet, hit Steward `/auth/verify`, get a JWT carrying `address`, eliza-cloud's `syncUserFromSteward` finds them by `wallet_address` and links the new `steward_user_id` onto their existing row. **No data migration script needed.**

4. **`app/login/steward-login-section.tsx`** — add a "Connect Wallet" button. Two viable options:
   - **Cheap path:** Reuse the existing Privy SDK *just for the wallet connection step*, then call `auth.signInWithSIWE(address, signMessage)`. Privy's modal handles WalletConnect, MetaMask, embedded wallets, etc. We're already paying for Privy through the migration window anyway.
   - **Clean path:** Drop in `wagmi` + `@rainbow-me/rainbowkit`. ~3-5 hr to wire up but adds permanent deps. Better long-term.
   - Either way, the SDK call is a one-liner: `await auth.signInWithSIWE(address, async (msg) => walletClient.signMessage({ message: msg }))`.

5. **Account-linking edge case:** if a Privy wallet user has *also* set up an email post-migration via Steward, we'd potentially have two `users` rows (one created by email-first sync, one by wallet-first sync). The `findByWalletAddress` shortcut in step 3 avoids this if we always check wallet first. Need to think through ordering. Probably: prefer matching by `steward_user_id` → `email` → `wallet_address` (current order with wallet bumped to second-to-last). For the 269 legacy users specifically, they have no email, so wallet-only lookup is unambiguous.

---

## Estimate

| Component | Size |
|---|---|
| Steward server: SIWE-side `users` upsert + `userId` in JWT + lowercase normalization | **S** (~2 hr, includes tests) |
| Steward server: domain allowlist for `siweMessage.domain` | **S** (~1 hr) |
| Steward server: Redis-backed nonce store | **S** (~2 hr, plumbing already exists) |
| Steward server: respect `X-Steward-Tenant` and skip auto-tenant-creation | **S** (~2 hr) |
| Steward DB: unique index on `LOWER(wallet_address)` (migration) | **S** (~30 min) |
| Eliza-cloud: wallet-address lookup branch in `syncUserFromSteward` | **S** (~1 hr) |
| Eliza-cloud: "Connect Wallet" UI in `steward-login-section.tsx` (Privy reuse path) | **M** (~4-6 hr) |
| Eliza-cloud: same UI but clean (wagmi + RainbowKit) | **M** (~1 day) |
| End-to-end testing with a real wallet against staging | **M** (~half day) |
| Optional: enable SIWE button in `@stwd/react`'s `StewardLogin` widget | **M** (~half day, if we want it for waifu/Babylon) |

**Total: 3-4 days for the full path** (Privy-reuse on the UI), 5-6 days for the clean wagmi path. The "first PR" can be much smaller — see below.

---

## Risks / Open Questions

**Top 3:**

1. **In-memory `nonceStore` is the production blocker.** The Steward API runs as multiple instances behind a load balancer in production (or at least is intended to). Today, a nonce issued by instance A and submitted to instance B will fail. This isn't theoretical — the comment at `packages/api/src/services/context.ts:97` literally says "SIWE nonce store" and is exported but unused, suggesting someone started a migration to a shared store and didn't finish. **Must move to Redis before any prod traffic hits SIWE.**
2. **Address case mismatch between Steward (checksum) and eliza-cloud (lowercase).** Will silently break the wallet→user lookup unless we normalize on the Steward side (one-line fix) or handle it defensively in eliza-cloud's sync (also a one-line fix). Pick the Steward side: it's the source of truth and other tenants (Babylon, waifu) will hit the same issue.
3. **No `siweMessage.domain` validation today.** A SIWE message signed for `evil.com` will currently verify successfully against Steward and mint a session. Low risk in practice (an attacker would need to convince the user to sign a message containing `evil.com` as the domain, which most wallet UIs surface clearly), but it's a free hardening win.

**Other open questions:**

- **Do we want to add `farcaster` SIWF for real?** The task brief implies it already exists; my grep says it doesn't. If Babylon needs it, that's a separate ~2-day project (sign-in-with-farcaster lib, frame message verification, FID → user mapping). Worth confirming with Shadow before scoping.
- **Wallet rotation / key compromise:** SIWE doesn't have any built-in concept of "this wallet is compromised, log everyone out and require a new sign-in." Privy handles this via account abstraction. For our use case (read-only API access via session JWT, wallet not used to sign txs through Steward), the blast radius of a compromised key is limited to "the attacker can sign in as this user." Mitigations: short JWT TTL (already 15m), refresh-token revocation (`DELETE /auth/sessions` already exists), per-tenant rate limits.
- **Chain ID:** Hardcoded to `1` in the SDK. Fine for now. If we ever care about chain-bound sessions, plumb through.
- **Wallet-only forever vs. linking-only:** The task asks whether wallet-only accounts (no email, ever) should be a first-class thing. My read: **yes, but expose it as "connect wallet to add a sign-in method"** for new users, while letting the 269 legacy Privy wallet-only users keep signing in with just their wallet indefinitely. We don't want to force them to add email — that's exactly the friction we're trying to avoid. Long-term, encourage email as a recovery method but don't require it.
- **`X-Steward-Tenant` header behavior in the SDK:** The SDK's `signInWithSIWE` does pass `X-Steward-Tenant` if `this.tenantId` is set in the constructor (`auth.ts:582-584`). Good, eliza-cloud's `new StewardAuth({ ..., tenantId: "elizacloud" })` (in `steward-login-section.tsx:36`) will route correctly. But the server still auto-creates a wallet-tenant first and then "switches" — wasteful. Cleanup item, not a blocker.

---

## Short-term alternative (if SIWE is too big for now)

**It's not too big** — it's already 95% built — but for completeness:

**Option B: Keep Privy login alive on eliza-cloud just for legacy wallet-only users.**

- **What it looks like:** Re-enable the Privy SDK flow but only show the "Connect Wallet" button in the Privy modal (hide email/Google/etc). When the user authenticates, eliza-cloud's existing `verifyAuthTokenCached` path (`packages/lib/auth.ts:240+`) handles them as before via `getByPrivyId`.
- **Cost:**
  - Privy is at ~$1k/month at current MAU (per Shadow's earlier analysis); keeping it alive for 269 users keeps that bill.
  - Two parallel auth systems = double the surface area for bugs and double the on-call cost.
  - User experience is split: most users see Steward UI, wallet users see Privy UI. Confusing.
  - 90-day-active wallet users only number 95, so the cost-per-active-user is bad.
- **When this makes sense:** Only if there's some Steward-side blocker we missed (there isn't). Dead-simple to implement (~1 day, mostly conditional UI), but it's strictly worse than just finishing the SIWE path.

**Verdict:** Don't do Option B. Finish SIWE.

---

## First PR Scope

**Smallest viable PR (≤ 1 day, server-only):**

1. `packages/api/src/routes/auth.ts:776-832` — modify `/auth/verify` to:
   - Lowercase `address` before any DB write or read.
   - Upsert into `users` table for SIWE-only logins.
   - Include `userId` in `createSessionToken` payload.
2. `packages/db/migrations/` — add migration for `uniqueIndex("users_wallet_address_unique")` on `LOWER(wallet_address)`.
3. Add a unit test in `packages/api/src/__tests__/` covering: nonce → mock-signed SIWE message → verify → JWT contains `userId`.

**That's the PR.** It unblocks eliza-cloud (the cloud team can ship the UI changes against the new behavior) and is a small, reviewable diff.

**Follow-up PRs in order:**

- PR 2: Redis nonce store (~2 hr).
- PR 3: SIWE domain allowlist + tenant-creation gating on `X-Steward-Tenant` (~3 hr).
- PR 4 (eliza-cloud): wallet-address lookup branch in `syncUserFromSteward` + Connect Wallet button (~half day to one day).
- PR 5 (`@stwd/react`): wire up the `StewardLogin` widget's SIWE button (optional, only if Babylon/waifu want it).

---

## Recommended Path

**Do SIWE.** The work was done six months ago and somebody just never finished the last 5%. The legacy Privy users are not blocked on a research project — they're blocked on:
- Steward putting `userId` in the SIWE JWT (10-line change)
- Eliza-cloud adding a wallet-lookup branch to its sync (15-line change)
- Eliza-cloud showing a "Connect Wallet" button on the login page (one component)

Total real engineering ≈ 2-3 days end-to-end including testing. The Privy-fallback alternative costs ~$12k/year in license + ongoing maintenance complexity, for a strictly worse user experience.

**Don't force legacy users to add email.** That's a 269-user re-onboarding flow with predictable drop-off. Wallet-only sign-in is what they signed up for; honoring it is cheap.

**Stretch goal:** while we're in there, finish the `StewardLogin` widget's SIWE button so Babylon (which is crypto-native) and waifu can drop the SIWE button in for free. Half-day of polish that pays dividends across all three tenants.

---

*Plan written by Sol, 2026-04-17, after ~20 min of code spelunking. Confidence: high on the "SIWE already exists" finding (multiple independent code paths confirmed). Confidence: medium on the effort estimate — eliza-cloud's UI work could grow if we go the wagmi+RainbowKit route or if Account-linking edge cases multiply.*
