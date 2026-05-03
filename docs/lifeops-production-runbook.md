# LifeOps Production Runbook

This runbook covers deployment validation, monitoring, alerting inputs, and rollback for the Life Ops slice.

## Preconditions

- Build and tests pass for the life-ops suites.
- API auth is configured for any non-loopback deployment via `ELIZA_API_TOKEN`.
- Connector credentials are provided only through environment variables:
  - Google OAuth: `ELIZA_GOOGLE_OAUTH_*` or `ELIZA_GOOGLE_OAUTH_*`
  - Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
  - X: `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`

## Deployment Smoke Check

Run this against every deployed origin after rollout and on a recurring monitor:

```bash
ELIZA_LIFEOPS_BASE_URLS=https://app.example.com \
ELIZA_SMOKE_API_TOKEN=$ELIZA_API_TOKEN \
node scripts/smoke-lifeops.mjs
```

If Google Calendar is expected to be connected in the target environment, require that explicitly:

```bash
ELIZA_LIFEOPS_BASE_URLS=https://app.example.com \
ELIZA_SMOKE_API_TOKEN=$ELIZA_API_TOKEN \
ELIZA_LIFEOPS_EXPECT_GOOGLE_CONNECTED=true \
node scripts/smoke-lifeops.mjs
```

The smoke check validates:

- `GET /api/lifeops/overview`
- `GET /api/lifeops/browser/sessions`
- `GET /api/lifeops/connectors/google/status`
- `GET /api/lifeops/calendar/next-context?timeZone=UTC` when Google has Calendar capability
- `GET /api/lifeops/gmail/triage?maxResults=5` when Google has Gmail triage capability or `ELIZA_LIFEOPS_EXPECT_GMAIL_TRIAGE=true`

The deploy workflow also runs this automatically on the app origin in [deploy-origin-smoke.yml](../.github/workflows/deploy-origin-smoke.yml).

## Assumptions And Limits

- Live connector tests remain env-gated and will stay skipped until real Google/Twilio credentials and callback marker files are provided.
- `smoke-lifeops` only validates capabilities that are actually granted. A Gmail-only Google grant should not be forced through Calendar routes, and a Calendar-only grant should not be forced through Gmail routes.
- For auth-protected deployments, `ELIZA_SMOKE_API_TOKEN` must be populated in the deployment smoke environment.
- A green life-ops smoke run does not clear the workspace dependency audit. Use `bun run audit:deps` for the full advisory inventory and `bun run audit:deps:release` for the deployment gate.
- As of April 4, 2026, the full audit still reports `GHSA-848j-6mx2-7j84` (`elliptic`) through `@elizaos/core` in `eliza-cloud-agent`. There is no newer published `elliptic` release to force, so the release gate is currently set to `moderate+` while that upstream low-severity advisory is tracked separately.

## Monitoring Signals

### Structured integration telemetry

Life Ops now emits `[integration]` log lines with `boundary: "lifeops"` for route handling and connector calls.

Watch these operations:

- `GET /api/lifeops/connectors/google/status`
- `GET /api/lifeops/calendar/feed`
- `GET /api/lifeops/calendar/next-context`
- `GET /api/lifeops/gmail/triage`
- `POST /api/lifeops/reminders/process`
- `twilio_sms`
- `twilio_voice`
- `x_post`

### Runtime warnings/errors

Watch these log patterns:

- `[lifeops] Route failed:`
- `[lifeops] Route crashed:`
- `[lifeops] Reminder delivery failed`
- `[lifeops] Twilio request failed:`
- `[lifeops] X post failed:`

### Durable audit trail

For reminder and connector incidents, inspect:

- `GET /api/lifeops/reminders/inspection?ownerType=...&ownerId=...`
- `GET /api/lifeops/overview`
- `GET /api/lifeops/connectors/google/status`

Reminder inspection returns both attempts and `life_audit_events`, which is the primary forensic record for delivery failures and connector decisions.

## Alert Inputs

Wire alerts from the deployment platform using either recurring smoke checks or log queries.

Recommended pages:

1. Smoke check exits non-zero for any production origin.
2. Any `[integration]` event with `boundary: "lifeops"`, `outcome: "failure"`, and `operation` starting with `GET /api/lifeops/calendar` or `GET /api/lifeops/gmail` for 5 continuous minutes.
3. Any `[lifeops] Reminder delivery failed` log for `sms` or `voice`.
4. Google connector status flips to `reason: "needs_reauth"` on environments that require calendar or Gmail.

In-repo wiring now exists for deployment smoke via [deploy-origin-smoke.yml](../.github/workflows/deploy-origin-smoke.yml), but external notification routing still depends on GitHub notification settings or the deployment platform's alerting destination.

## Rollback

If the rollout causes failures, revert to the previous known-good deployment artifact or commit SHA, then rerun the smoke check.

Typical git rollback flow:

```bash
git checkout <previous-good-sha>
bun install --frozen-lockfile
bun run build
```

Typical container rollback flow:

1. Redeploy the previous image tag.
2. Re-run `node scripts/smoke-lifeops.mjs` against the restored origin.
3. Confirm connector status and reminder inspection are healthy.

If the issue is isolated to external delivery, you can also perform a connector-only mitigation while code rollback is in progress:

- disconnect Google via `POST /api/lifeops/connectors/google/disconnect`
- disable escalation channels via `POST /api/lifeops/channel-policies`

## Release Gate

Do not ship when any of these are true:

- life-ops smoke check fails
- life-ops tests fail
- dependency audit returns unresolved high-severity issues in the deployed runtime graph
- no alerting target is attached to the smoke check or life-ops failure logs
