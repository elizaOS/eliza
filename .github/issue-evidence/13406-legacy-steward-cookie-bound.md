# Legacy Steward Cookie Bound Evidence

Tracker: #13406 project board draft item, "auth) bound legacy-cookie migration so staging/dev stop reading prod cookies".

## Claim

Non-production Steward session teardown now owns only the environment-suffixed cookie names. Production/unset environments still own the historical unsuffixed names, so production logout behavior is preserved while staging/dev can no longer clear production's shared-parent-domain cookies during the bounded legacy migration.

## Manual Review

- Reviewed `packages/cloud/api/auth/logout/route.ts`: staging reads and clears only `steward-token-staging`, `steward-refresh-token-staging`, and `steward-authed-staging`; production/unset may read and clear the historical unsuffixed cookies.
- Reviewed `packages/cloud/api/auth/logout/route.ts`: server-side teardown is gated on an environment-owned Steward token, so staging/dev logout cannot resolve a production user through the bounded legacy fallback and end production sessions.
- Reviewed `packages/cloud/api/auth/steward-session/route.ts`: DELETE clears suffixed cookies in non-production and clears the legacy names only when `canMutateLegacyStewardCookies()` says the Worker owns them.
- Reviewed `packages/cloud/api/auth/steward-refresh/route.ts`: non-production reads only its suffixed refresh cookie, so a legacy-only unsuffixed refresh cookie is rejected before any Steward upstream call; rejected browser refresh clears the environment-scoped cookie names and does not clear `steward-authed` outside production/unset.
- Reviewed `packages/cloud/shared/src/lib/auth/steward-cookies.ts`: the mutation guard is explicit and isolated beside the cookie name resolver, so future read-fallback callers do not imply write/delete authority. The legacy fallback wording now states that non-production refresh-only sessions re-authenticate because legacy refresh cookies are not read.
- Reviewed the focused test output by hand; the new assertions check `Set-Cookie` deletion names, including denied legacy deletion in staging and preserved legacy deletion in production.

## Verification

```bash
bunx @biomejs/biome check \
  packages/cloud/shared/src/lib/auth/steward-cookies.ts \
  packages/cloud/shared/src/lib/auth/steward-cookies.test.ts \
  packages/cloud/api/auth/steward-session/route.ts \
  packages/cloud/api/auth/steward-refresh/route.ts \
  packages/cloud/api/auth/logout/route.ts \
  packages/cloud/api/__tests__/steward-session-delete-scopes-cookie-clears.test.ts \
  packages/cloud/api/auth/steward-refresh/route.test.ts \
  packages/cloud/api/auth/logout/route.test.ts
# Checked 8 files in 37ms. No fixes applied.

git diff --check
# exit 0

bun test --reporter=dots \
  packages/cloud/api/auth/steward-refresh/route.test.ts \
  packages/cloud/api/auth/logout/route.test.ts
# 8 pass, 0 fail, 41 expect() calls

bun test --reporter=dots --coverage-reporter=lcov \
  packages/cloud/api/__tests__/steward-session-delete-scopes-cookie-clears.test.ts \
  packages/cloud/shared/src/lib/auth/steward-cookies.test.ts
# 5 pass, 0 fail, 21 expect() calls

bun run audit:error-policy-ratchet -- --report
# no new fallback-slop in touched files
```

## Evidence Rows

- Real request/response traces: covered by route-level Hono `app.request`/`app.fetch` tests that assert the actual response `Set-Cookie` deletion names for `/api/auth/steward-session`, `/api/auth/steward-refresh`, and `/api/auth/logout`, plus the staging legacy-only logout test that proves production session teardown is not invoked and the staging legacy-only refresh test that proves the production refresh cookie is not forwarded to Steward. A full `cloud:mock` deployment was not run for this draft because the change is limited to cookie/session ownership boundaries in route code.
- Backend logs: N/A. The touched paths do not add or require new structured log lines; the observable artifact is the response cookie deletion set.
- DB/domain artifacts: N/A. No database rows, billing records, migrations, memory, knowledge, scheduled tasks, wallet, chain, files, or device artifacts are created or changed.
- Real LLM trajectories: N/A. No agent, provider, prompt, model, or action behavior changes.
- Frontend logs, screenshots, and video: N/A. No UI/client code changes.
- Audio/native/device captures: N/A. No voice, native bridge, mobile install, or device behavior changes.
