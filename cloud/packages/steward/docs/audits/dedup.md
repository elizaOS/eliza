# Deduplication Audit

## Summary
- Duplications found: 4
- Consolidated: 1
- Recommended but not applied: 4 (reasoning below)

## Applied consolidations

### 1. SHA-256 hex hashing helper
- Was: defined in `packages/api/src/routes/auth.ts`, `packages/auth/src/email.ts`, and `packages/auth/src/api-keys.ts`
- Now: exported from `packages/auth/src/crypto.ts` as `hashSha256Hex()`
- Callers updated: 3 files
- Reasoning: these copies all sit on the auth boundary already, and `@stwd/api` already depends on `@stwd/auth`, so this removes duplication without introducing a new runtime packaging dependency.

## Deferred (high risk / unclear)

### A. Seed script API key hashing
- Found in:
  - `packages/seed/src/index.ts`
- Assessment: this is still identical to the extracted auth helper, but moving it to `@stwd/shared` would require changing how `@stwd/shared` is consumed at runtime in this worktree because that package currently exports `dist/` artifacts rather than source.
- Recommendation: either keep this local, or separately modernize `@stwd/shared` packaging before promoting runtime helpers into it.
- Risk: medium, because the packaging cleanup is larger than this DRY task.

### B. API vault construction from env defaults
- Found in:
  - `packages/api/src/services/context.ts`
  - `packages/api/src/routes/user.ts`
  - `packages/api/src/routes/platform.ts`
  - `packages/api/src/routes/auth.ts`
- Assessment: `rpcUrl` and `chainId` defaults are repeated, and two route files also duplicate insecure dev fallback handling for `STEWARD_MASTER_PASSWORD`.
- Recommendation: extract an API-local helper such as `buildVaultFromEnv()` plus a small `getVaultRuntimeConfig()` function.
- Risk: medium, because route behavior differs slightly between strict and dev-fallback callers.

### C. Session secret bootstrap logic
- Found in:
  - `packages/api/src/services/context.ts`
  - `packages/api/src/routes/auth.ts`
- Assessment: the `STEWARD_SESSION_SECRET || STEWARD_MASTER_PASSWORD` bootstrap logic is duplicated. This is extractable, but these modules also own related startup warnings and singleton setup.
- Recommendation: centralize behind an API config helper only if paired with a broader auth config cleanup.
- Risk: medium, because startup-time side effects need to remain identical.

### D. Auth email defaults inside API auth route
- Found in:
  - repeated `EMAIL_FROM || "login@steward.fi"`
  - repeated `APP_URL || "https://steward.fi"`
  - repeated `new EmailAuth(...)` setup in `packages/api/src/routes/auth.ts`
- Assessment: worthwhile locally, but only within a single file. Lower leverage than the shared hash helper.
- Recommendation: fold to module constants or a `buildEmailAuthConfig()` helper if this route is touched again.
- Risk: low.

## Files changed
- `QUALITY_AUDIT.md`
- `packages/api/src/routes/auth.ts`
- `packages/auth/src/api-keys.ts`
- `packages/auth/src/email.ts`
- `packages/auth/src/crypto.ts`
- `packages/auth/src/index.ts`
