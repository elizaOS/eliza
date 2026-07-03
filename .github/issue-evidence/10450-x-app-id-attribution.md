# Issue #10450 - X-App-Id attribution hardening

## What changed

- `POST /api/v1/messages` and `POST /api/v1/chat/completions` no longer trust
  an arbitrary `X-App-Id` header for app-credit/creator-earnings attribution.
- A monetized app id is honored only when:
  - the caller belongs to the app's owning organization, or
  - the caller has a durable app-auth connection to that app.
- Durable app-auth connections are represented by `app_users.signup_source =
  "oauth"`. Plain inference analytics may still create `app_users` rows, but
  those rows do not authorize future attribution.
- `/api/v1/app-auth/connect` now upgrades an existing analytics-created
  `app_users` row to the OAuth grant state, so legitimate users are not blocked
  if an analytics row already existed.

This addresses finding 1 from issue #10450. Finding 2's per-org app creation cap
still needs a product/tier cap value. Draft PR #10455 separately covers the raw
app-create GitHub repo default.

## Validation

Base commit: `426a1676f4 fix(cloud): proof-of-control wallet provisioning; revert #10382 org-scoped RPC regression (#10279) (#10438)`

Commands run from `/home/shaw/eliza/eliza-issue-10450-xappid`:

```bash
bun run install:light
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/core build:node
git diff --check
bunx @biomejs/biome check packages/cloud/shared/src/db/repositories/apps.ts packages/cloud/shared/src/lib/services/apps.ts packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts packages/cloud/api/v1/messages/route.ts packages/cloud/api/v1/chat/completions/route.ts
bun test packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts --reporter=dot
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
```

Observed results:

- `git diff --check`: passed.
- Focused Biome check: passed, `Checked 5 files`.
- Apps repository/service PGlite suite: passed with `17 pass`, `0 fail`, `74
  expect() calls`.
- `packages/cloud/shared` typecheck: passed.
- `packages/cloud/api` typecheck: passed.

## Human-verifiable behavior

- Same-org callers can still use a monetized app id for app-credit attribution.
- Cross-org callers with no app-auth connection cannot attribute inference to
  another org's app.
- A cross-org analytics-created `app_users` row is not sufficient to authorize
  attribution.
- A later app-auth connect call upgrades that existing row to `signup_source:
  "oauth"`, after which the cross-org user can legitimately attribute to the app.
- Unauthorized app ids are dropped before app-credit reconciliation and before
  downstream chat-completion metadata receives an app id.

Screenshots/video/Android capture: N/A. This is a cloud backend authorization
and accounting-boundary change with no UI, native, or attached-Android surface.
