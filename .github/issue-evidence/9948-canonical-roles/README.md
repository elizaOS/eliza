# Evidence — #9948 canonical role model + wallet sign-route hardening

Branch: `fix/9946-9961-sec-roles-tui-cloud-embed` · Host: Linux x86_64

## What shipped (high-confidence slice)
- **Reconciled the two disagreeing rank tables.** `runtime/context-gates.ts`
  defined a third `ROLE_RANK` (NONE|GUEST|USER|MEMBER|ADMIN|OWNER with
  USER==MEMBER) independent of the canonical one in `roles.ts`. It now *derives*
  its ordering from the canonical `ROLE_RANK` so GUEST<USER<ADMIN<OWNER can never
  silently disagree. Values are byte-for-byte identical to before → **no behavior
  change**; `normalizeGateRole`/`roleRank` signatures untouched.
- **Deduped `hasRoleAccess`.** `packages/agent/src/security/access.ts` now
  re-exports the core `hasRoleAccess` instead of carrying a parallel wrapper —
  one role check.
- **Canonical conversion helper.** Added `normalizeToRoleName(Role): RoleName`
  (MEMBER→USER, NONE→GUEST) to `roles.ts` (additive).
- **Wallet sign-route CORS hardening (the live security gap).** The EVM + Solana
  browser signing routes (`personal-sign`, `sign-typed-data`, `sign-transaction`,
  `send-transaction`) reflected the request `Origin` (defaulting to `*`) into
  `Access-Control-Allow-Origin` **and** set `Access-Control-Allow-Credentials:
  true` on a signing endpoint. Fixed:
  - Removed `Access-Control-Allow-Credentials` (auth is a bearer token, not
    cookies — credentials were never needed and made reflected-origin dangerous).
  - Replaced blind origin reflection with a `WALLET_BROWSER_SIGN_ORIGINS`
    allowlist; non-allowlisted / unconfigured → no `Access-Control-Allow-Origin`
    (default-deny cross-origin). `Vary: Origin` kept.
  - Routes stay `public:true` (the browser shim must reach them); the bearer
    token + origin allowlist are the protection.

## Tests
- `role-rank-consistency.test.ts` — **6 passed** (gate table matches canonical
  for all shared members; MEMBER==USER; NONE<GUEST; OWNER is max;
  normalizeToRoleName mapping).
- Wallet EVM+Solana `sign.test.ts` + new `sign.cors.test.ts` — **26 passed**
  (no credentials header; non-allowlisted origin not reflected; allowlisted
  origin reflected via runtime setting + env; default-deny; 503 w/o token; 401
  w/o bearer).
- Regression: `roles.test.ts` 7 passed; `context-registry.test.ts` 6 passed.
- `tsc --noEmit`: core / plugin-wallet / agent → **0 errors**.

## Deferred (documented, not in this slice)
- Full role-aware HTTP boundary tiers across the 73 app-core API files (binary
  `isAuthorized` → role tiers) and threading `accessContext` into the ~166
  `getMemories` calls. These are large cross-cutting refactors that overlap
  #9853 multi-tenant work and warrant their own PRs.
- Collapsing the 5-tier `Role` (NONE/MEMBER) and 4-tier `RoleName` into a single
  type was intentionally NOT done destructively (high blast radius); the
  `normalizeToRoleName` bridge + derived rank table remove the *silent
  disagreement* hazard, which was the security-relevant core of the issue.
