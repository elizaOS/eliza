# Evidence: #14298 Account page organization language

## Scope

- Removed the Account page welcome-card organization membership copy.
- Removed the Organization card from the reachable Account page and deleted its
  now-unused component.
- Changed residual read-only role helper copy from organization-focused wording
  to account-focused wording.
- Kept the backend `user.organization` data shape intact; the Account surface
  simply no longer promotes that tenancy data in plain user settings.

## Verification

```bash
bun run --cwd packages/ui test -- src/cloud/account-security/components/account-page-client.test.tsx
```

Result: passed, 1 file / 2 tests.

```bash
bunx @biomejs/biome check \
  packages/ui/src/cloud/account-security/AccountSurface.tsx \
  packages/ui/src/cloud/account-security/components/account-page-client.tsx \
  packages/ui/src/cloud/account-security/components/account-page-client.test.tsx \
  packages/ui/src/cloud/account-security/components/profile-form.tsx \
  packages/app/test/ui-smoke/cloud-surfaces-aesthetic-audit.spec.ts \
  .github/issue-evidence/14298-account-page-org-language.md
```

Result: passed, no fixes applied.

```bash
git diff --check origin/develop...HEAD
```

Result: passed.

## App Audit

Full `audit:app` still fails outside this PR's Account page diff, on the
existing app-audit minimalism ratchet recorded in the PR thread. This audit does
not enter CloudRouterShell routes, so it does not capture `/dashboard/account`.

## Cloud Account Audit

The cloud audit table was extended to cover registered dashboard control-plane
routes that were missing from the walk, including `/dashboard/account`.

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.nvm/versions/node/v24.15.0/bin/node \
ELIZA_UI_SMOKE_PORT=2238 \
ELIZA_UI_SMOKE_API_PORT=32337 \
  bun run --cwd packages/app audit:cloud
```

Result: passed, 85 passed / 1 skipped.

Artifacts reviewed by hand:

- `packages/app/aesthetic-audit-output-cloud/desktop/dashboard-account.png`
- `packages/app/aesthetic-audit-output-cloud/mobile/dashboard-account.png`
- `packages/app/aesthetic-audit-output-cloud/desktop/dashboard-account--hover.png`
- `packages/app/aesthetic-audit-output-cloud/manual-review/dashboard-account.md`

Manual review verdict: good for desktop and mobile. The Account page renders
without the Organization card, organization name/member copy, banned blue
colors, orange hover violations, or layout overlap.

## Evidence Gaps

- Before screenshot: N/A; this PR verifies the corrected Account rendering and
  regression tests rather than preserving a separate pre-change capture.
- Video walkthrough: N/A; static Account copy/removal change with rendered
  screenshot evidence.
- Backend logs and domain artifacts: N/A; presentation-only change over
  already-loaded user tenancy data.
