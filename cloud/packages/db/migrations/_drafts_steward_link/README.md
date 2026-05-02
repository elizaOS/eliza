# Steward identity link migration — DRAFT

**Status:** Draft. Operator-owned. Not in the active migration sequence.

This directory contains SQL migrations that finalize the Privy →
Steward identity transition documented in
`cloud/AUTH_MIGRATION_NOTES.md`. They are kept outside
`packages/db/migrations/` so the Drizzle migration runner does **not**
pick them up automatically. When ready, the operator copies them in
under the next available sequence number, runs them against staging,
then production.

## Why this is a draft

- Schema changes affect every authenticated user. Mistakes are not
  silently recoverable; they require a snapshot restore.
- Phase 3 drops columns. There is no in-place undo for a `DROP COLUMN`.
- The right time to finalize depends on a backfill that runs in
  application code, not in a migration. The operator decides when
  enough users have been re-authenticated to safely drop the legacy
  identifiers.

## Current state of the world (as of this draft)

- `users.privy_user_id` and `users.steward_user_id` both exist as
  nullable, unique TEXT columns.
- `user_identities.privy_user_id` and `user_identities.steward_user_id`
  both exist as nullable, unique TEXT columns.
- The `steward_user_id` columns were added by the already-applied
  migration `packages/db/migrations/0061_add_steward_user_identity_columns.sql`.
- The application authenticates new sessions via Steward only;
  `syncUserFromSteward` (`packages/lib/steward-sync.ts:471`) links
  matched-by-email and matched-by-wallet rows by writing
  `users.steward_user_id` and calling
  `usersService.upsertStewardIdentity` to project the link onto
  `user_identities`.
- No row is yet required to have `steward_user_id`. Anonymous users,
  Eliza-app-only identity rows (Telegram/Discord/WhatsApp/phone), and
  unmigrated Privy users may all still be `steward_user_id IS NULL`.

See `INVENTORY.md` for the column-by-column table audit.

## The three phases

### Phase 1 — additive (`0001_add_steward_user_id_columns.sql`)

Already done in production by migration `0061`. The Phase 1 file in this
draft is a **verification-only no-op** — it asserts the expected columns
and indexes exist and raises `EXCEPTION` if anything is missing. Run it
once before Phase 3 to fail fast if 0061 was somehow skipped or partially
applied.

### Phase 2 — application-level backfill (no SQL file)

Handled in `packages/lib/steward-sync.ts`, not in a migration:

1. When a user authenticates via Steward, `syncUserFromSteward` looks
   them up by Steward user ID, then by email, then by wallet.
2. If a match is found by email/wallet, the existing user row is updated
   with `steward_user_id = <stewardUserId>` and the projection is upserted
   onto `user_identities`.
3. After enough time has passed for the active user base to re-authenticate
   at least once, run the unlinked-row count query (below) to confirm
   completeness.

This phase is intentionally not a migration — it's the application
naturally learning the mapping as users sign in. The operator may also
run a one-shot reconciliation script that pre-links accounts by email
match before the maintenance window, to reduce the unlinked count.

The application-side change required to make Phase 2 fully effective is:

```ts
// packages/lib/steward-sync.ts (around line 482)
// EXISTING behaviour (good): when an email/wallet match is found,
// users.steward_user_id is set and upsertStewardIdentity is called.
// VERIFY: that this happens for every match path, including the
// migration-of-anonymous-session path.
```

The repository helper `usersService.upsertStewardIdentity(userId,
stewardUserId)` already exists in
`packages/db/repositories/users.ts:818`. No new code is required —
operator should verify by reading the linking branch in
`steward-sync.ts:482-510` and confirming `upsertStewardIdentity` is
called there (it is, at line 493 as of this draft).

### Phase 3 — finalize (`0002_finalize_steward_user_id.sql`)

Run only after Phase 2 has stabilized.

- Asserts the unlinked-active-user count is zero, inside the same
  transaction.
- Promotes `users.steward_user_id` to `NOT NULL` using the
  `ADD CONSTRAINT ... CHECK ... NOT VALID` + `VALIDATE CONSTRAINT` +
  `SET NOT NULL` pattern. This avoids a table-blocking scan under
  `ACCESS EXCLUSIVE` on the `users` table.
- Promotes `user_identities.steward_user_id` to `NOT NULL` using the
  same pattern (kept consistent for clarity).
- Drops `users.privy_user_id` and `user_identities.privy_user_id`. The
  attached unique constraints and indexes are dropped automatically.
- Drops the named btree indexes `users_privy_idx` and
  `user_identities_privy_user_id_idx` defensively (they should already
  be gone after the column drop, but `IF EXISTS` makes this idempotent).

## Pre-flight checklist

Operator must check **every** item before promoting these drafts into
`packages/db/migrations/`:

- [ ] Take a full DB snapshot for the target environment.
- [ ] Run the unlinked-row count query (see "Verification queries"
      below) and confirm the result is zero, OR run a reconciliation
      script that links the remaining rows.
- [ ] Confirm no application code reads `privy_user_id`. As of this
      draft, the following callsites must be removed in a code PR
      that lands BEFORE the migration runs:
      - `packages/db/repositories/users.ts` (legacy lookup helpers
        `findByPrivyId*`, `upsertPrivyIdentity`, etc. — entire
        Privy-id codepath)
      - `packages/db/repositories/eliza-room-characters.ts:151`
        (the `OR (u.email LIKE ... AND u.privy_user_id IS NULL)`
        clause — replace with `steward_user_id IS NULL`)
      - `api/my-agents/claim-affiliate-characters/route.ts:82`
        (`!owner.privy_user_id` check — replace with
        `!owner.steward_user_id`)
- [ ] Update the Drizzle schema files
      (`packages/db/schemas/users.ts`,
      `packages/db/schemas/user-identities.ts`) to remove
      `privy_user_id` and mark `steward_user_id` non-nullable. The
      schema change must land in the same deploy as the migration so
      Drizzle's diff logic does not regenerate a re-add of the dropped
      columns.
- [ ] Schedule a maintenance window. Phase 3 is intended to run
      offline. The `ACCESS EXCLUSIVE` lock during column drop is brief
      (metadata only) but the `VALIDATE CONSTRAINT` step does scan the
      table.
- [ ] Run Phase 1 verification (`0001_add_steward_user_id_columns.sql`)
      against staging first. It should print
      `NOTICE: Phase 1 verification passed: ...` and complete in <100ms.
- [ ] Run Phase 3 (`0002_finalize_steward_user_id.sql`) against staging
      first. Verify the post-migration queries below.
- [ ] After staging verification, repeat against production.

## Rollback plan

### Phase 1 rollback

The verification migration creates no objects. Nothing to roll back. If
it fails, fix the missing column/index by re-running migration `0061`.

### Phase 3 rollback (mid-transaction)

Inside the same `BEGIN; ... COMMIT;` block, any failure rolls the whole
migration back automatically. The defensive precondition check at the
top of Phase 3 will trigger this rollback if there are unlinked active
users.

### Phase 3 rollback (after COMMIT)

There is no in-place undo. The `privy_user_id` columns are gone. The
only recovery is **restore from the pre-migration snapshot** (taken in
the pre-flight checklist).

If the operator only needs to restore the *columns* (without restoring
data — e.g. because Phase 3 ran cleanly but a downstream code path
turned out to need `privy_user_id`), they can re-add empty columns by
running the additive halves of migrations `0000_last_reavers.sql` and
`0048_01_elite_rumiko_fujikawa_creates.sql` in sequence. This restores
the schema shape but leaves the columns NULL on every row — the
historical Privy IDs are not recoverable without a snapshot.

## Verification queries

### Pre-flight: confirm backfill is complete

Active human users that still need linking — must be zero before Phase 3:

```sql
SELECT COUNT(*) AS unlinked_active_users
FROM users
WHERE privy_user_id IS NOT NULL
  AND steward_user_id IS NULL
  AND is_active = TRUE
  AND is_anonymous = FALSE
  AND (email IS NULL OR email NOT LIKE 'affiliate-%@anonymous.elizacloud.ai');
```

Linked-row population — should grow over time as users re-auth:

```sql
SELECT
  COUNT(*) FILTER (WHERE steward_user_id IS NOT NULL) AS linked,
  COUNT(*) FILTER (WHERE steward_user_id IS NULL AND privy_user_id IS NOT NULL) AS privy_only,
  COUNT(*) FILTER (WHERE steward_user_id IS NULL AND privy_user_id IS NULL AND is_anonymous = FALSE) AS no_external_identity,
  COUNT(*) FILTER (WHERE is_anonymous = TRUE) AS anonymous
FROM users
WHERE is_active = TRUE;
```

Identity-projection consistency check — should be zero:

```sql
-- Users whose users.steward_user_id is set but user_identities row disagrees
SELECT u.id, u.steward_user_id AS users_steward, ui.steward_user_id AS identity_steward
FROM users u
JOIN user_identities ui ON ui.user_id = u.id
WHERE u.steward_user_id IS NOT NULL
  AND (ui.steward_user_id IS NULL OR ui.steward_user_id <> u.steward_user_id);
```

### Post-Phase-3: confirm the finalize succeeded

```sql
-- Both should be 'NO' (i.e. NOT NULL).
SELECT table_name, column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'steward_user_id'
  AND table_name IN ('users', 'user_identities');

-- Should return zero rows — the privy_user_id columns are gone.
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'privy_user_id'
  AND table_name IN ('users', 'user_identities');
```

## Risks and mitigations

| Risk                                                                    | Mitigation                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Active user lacks `steward_user_id` and Phase 3 fails the precondition. | The migration aborts inside its transaction with a clear error. Operator runs reconciliation, then re-tries.        |
| Application code still reads `privy_user_id` after column drop.         | Pre-flight checklist requires the code PR to land first. Audit the listed callsites and any greps for `privy_user_id`. |
| `VALIDATE CONSTRAINT` on a large `users` table holds locks too long.    | Run during a maintenance window. The lock is `SHARE UPDATE EXCLUSIVE` (allows concurrent SELECT/INSERT/UPDATE/DELETE), not `ACCESS EXCLUSIVE`. |
| Drizzle schema files not updated in the same deploy.                    | Update `packages/db/schemas/users.ts` and `packages/db/schemas/user-identities.ts` in the same PR that promotes these drafts. |
| Snapshot not taken; cannot restore.                                     | First item on the pre-flight checklist. Refuse to run without it.                                                   |
| Identity-projection drift (`users.steward_user_id` set but `user_identities.steward_user_id` not). | The pre-flight consistency query catches this. If it returns rows, run a one-shot UPDATE to sync them, then re-check. |

## Conventions followed

- **Single transaction per file** (`BEGIN;` / `COMMIT;`) — matches every
  applied migration in `packages/db/migrations/`.
- **`IF NOT EXISTS` / `IF EXISTS` guards** for idempotency — matches
  the convention in `0058`, `0060`, `0061`.
- **No `CREATE INDEX CONCURRENTLY`** — none of the existing migrations
  in this repo use it, so we don't either. (`CREATE INDEX CONCURRENTLY`
  cannot run inside a transaction; using it here would force splitting
  the migration into multiple files and break the all-or-nothing
  rollback story.) The only index work in Phase 3 is dropping indexes,
  which is metadata-only.
- **`DO $$ ... $$` blocks** for conditional DDL — matches the pattern
  in `0058_add_steward_wallet_provider.sql`.
- **Drizzle migration filenames** use a sequence prefix and a
  descriptive snake_case suffix. When the operator promotes these
  drafts, rename them to the next available sequence number (e.g.
  `0074_verify_steward_user_id_columns.sql` and
  `0075_finalize_steward_user_id.sql`) and update
  `packages/db/migrations/meta/_journal.json` accordingly. Drizzle
  will not regenerate the journal entry from the schema diff because
  these files are hand-authored (not generated by `drizzle-kit
  generate`); follow the convention used by the existing hand-authored
  migrations like `0050` and `0058`.
