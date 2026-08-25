# User-session telemetry lifecycle

`user_sessions` is usage telemetry. It records activity that was observed only
after an authenticated request, but it is never browser-session or revocation
authority. Steward's signed access cookie, Steward verification, the Cloud
account state, and the inference revocation fences are the authentication
authorities. A `user_sessions` row cannot authenticate or re-authorize anyone.

## Lifecycle and retention policy

- A new row receives the verified Steward access token's absolute expiry.
- A null-ended row is active only while both its token lifetime and a one-hour
  idle window remain open. Legacy rows without an expiry use
  `started_at + 1 hour`; this conservative fallback cannot extend authority.
- Logout closes telemetry with `logout`. Account deactivation, identity
  replacement, or organization movement closes it with `revoked`. The cleanup
  worker records `expired` or `idle`, and an explicit operator closure can use
  `administrative_cleanup`. Historical ended rows with unknowable provenance
  are backfilled as `legacy_ended` rather than relabelled as logout.
- Closure records `ended_at`, `ended_reason`, `retention_expires_at`, and
  `metadata_purged_at`. Closure immediately replaces the token hash with the
  non-secret `closed:<row-id>` locator and clears IP address, user agent, and
  device JSON. These fields are collected only for active diagnostics and are
  not retained after closure.
- Closed usage counters and lifecycle timestamps are retained for 30 days,
  then deleted. The daily cleanup processes at most 500 stale rows and 500
  retention deletions per invocation. `FOR UPDATE SKIP LOCKED`, null-ended
  closure predicates, and ended-only deletion predicates make retries and
  overlapping invocations safe.
- Cleanup logs and HTTP responses expose only `scanned`, `closed`, `retained`,
  `deleted`, and duration. They never include token hashes, row IDs, user or
  organization IDs, IPs, user agents, or device metadata.

Failed tracking remains best-effort and never changes an authentication result.
Natural expiry and idle filtering also work before cleanup runs, so cron delay
cannot make residue appear active.

## Staging-first backfill

Migration `0313_user_session_telemetry_lifecycle.sql` is additive and performs
no unbounded data rewrite. Deploy it to staging first. The backfill command is
dry-run by default and prints aggregate counts only:

```bash
bun run --cwd packages/cloud/shared db:backfill-user-session-lifecycle -- --environment=staging
bun run --cwd packages/cloud/shared db:backfill-user-session-lifecycle -- --environment=staging --apply --batch-size=500 --max-batches=1
```

Repeat one bounded staging batch at a time while checking database latency and
the remaining dry-run counts. Then exercise the provider-backed staging flow:
a fresh Steward session must appear, activity must update it, logout and token
expiry must remove it from `/sessions/current`, and a later retention run must
delete it. Do not print or attach raw rows.

Production application is gated on a redacted staging run receipt:

```bash
bun run --cwd packages/cloud/shared db:backfill-user-session-lifecycle -- \
  --environment=production --apply --batch-size=500 --max-batches=1 \
  --staging-proof=<redacted-run-url-or-receipt>
```

## Rollback

Before production, rollback is to stop the backfill and cron route, then revert
the application to the prior revision. The additive nullable columns and
indexes can remain; old readers ignore them, and active classification retains
the conservative legacy fallback. Do not drop the columns during the rollback
window.

Metadata minimization is intentionally irreversible: a rollback cannot restore
token hashes, IP addresses, user agents, or device JSON already purged from
ended rows. Usage counters and lifecycle timestamps remain until their 30-day
retention deadline. Database migration or cleanup execution in production
requires separate operator authorization; merging the code is not that
authorization.
