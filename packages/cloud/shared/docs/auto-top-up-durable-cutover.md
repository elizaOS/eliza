# Durable auto-top-up cutover

This runbook separates three things that must not be conflated:

- **Previous processor:** the pre-ledger implementation that can call Stripe
  directly and uses a time-bucket idempotency key.
- **Sealed bridge:** the transition release. It can reconcile payments that
  already exist, but it cannot create a new auto-top-up PaymentIntent.
- **Durable processor:** the follow-up release that records and leases an
  attempt before contacting Stripe and reuses one stable provider key.

The database control row is the charging authority. It starts in `paused`.
Deploying code or setting a Worker variable alone must never start charging.

## Invariant

At most one processor generation may be able to create an auto-top-up payment
for an organization. An invocation of an older Worker can remain in flight
after a newer version is deployed, so a deploy timestamp or quiet timer is not
a provider fence.

The organization-level covered-decrease revision is the canonical re-arm
fence. Existing organizations are conservatively baselined during migration;
a real `auto_top_up` credit advances the fence in the same database transaction
as the credit row. Retrying or changing processor versions must not re-arm an
organization without a later balance decrease.

## Transition release behavior

The sealed bridge intentionally creates a short maintenance window for
automatic card recharges:

1. the control row is created in `paused` mode;
2. cron and post-debit checks report paused and do zero charging work;
3. the authenticated manual trigger returns a distinct maintenance response;
4. signed webhooks may still reconcile provider payments created before the
   bridge was deployed;
5. organization deletion and the last user's departure are blocked while the
   control row is `paused`, because an older provider payment may not have been
   inventoried yet;
6. moving the control row to `durable` does not unseal this bridge binary.

Do not activate `durable` while only the bridge binary is deployed.
This foundation release does not expose an activation command. The durable
processor ships the reviewed, dry-run-first command at
`packages/cloud/scripts/admin/auto-top-up-cutover.ts`. It owns inventory,
quarantine resolution, and the guarded control transition. Direct SQL is not a
supported activation procedure.

The lifecycle guard is an intentional, operator-visible maintenance impact.
Migration `0217` enforces it globally: while `auto_top_up_control.mode` is
`paused`, it blocks organization deletion and last-user departure even when no
attempt or quarantine row is known, because a pre-cutover PaymentIntent may not
have been inventoried yet. After activation the guard becomes
organization-scoped: unresolved payments still block deletion or last-user
departure, and a terminal organization must have a zero primary credit balance
before its last user can leave.

API boundaries translate the stable database guard identifiers without
exposing SQL: a globally paused lifecycle operation returns `503
service_unavailable` with `Retry-After`, while organization-specific unresolved
work or a nonzero primary balance returns `409 billing_state_conflict`.

## Production activation (human-gated)

This procedure mutates payment infrastructure and secrets. It requires an
explicit operator approval and a claimed production lever. A normal merge or
deploy does not authorize it.

1. Deploy the sealed bridge and migrations, then verify that 100% of Worker
   traffic uses the reviewed version. Confirm manual and scheduled triggers do
   no charging work.
2. Deploy the durable-processor release with its secondary runtime kill switch
   disabled and the database control still `paused`.
3. Establish a provider-side fence against older Worker invocations. Use an
   approved replacement/revocation strategy for the Stripe credential capable
   of creating these PaymentIntents. Merely omitting a Worker secret is not
   proof: deploy tooling can preserve existing bindings.
4. Capture the fixed provider high-water, then run the checked-in command in
   its default dry-run mode. It pages through Stripe PaymentIntents with the
   authoritative list API for the complete interval from the Unix epoch through
   that high-water; it never uses Search. Because there is no authoritative
   legacy launch watermark, the command accepts only the Unix epoch as
   `--inventory-start`, passes `created.gte = 0`, and rejects every later lower
   bound. The provider credential action, evidence token, and timestamps remain
   explicit human-owned inputs, and the command never changes a Stripe secret
   or Worker binding.

   ```sh
   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
     --inventory-start 1970-01-01T00:00:00.000Z \
     --provider-fence-at 2026-08-17T12:00:00.000Z \
     --provider-fence-evidence INC-20717-key-revoked \
     --worker-version <full-40-hex-sha> \
     --output /tmp/auto-top-up-cutover.json
   ```

   This phase performs provider and primary-control reads only. Preserve the
   generated plan as evidence; do not edit it.
5. Drain and inspect the Stripe webhook queue and dead-letter queue. Successful
   intents must have exactly one matching credit; canceled intents must not have
   a credit. Safely identified processing or ambiguous intents enter durable
   manual review with auto-top-up disabled for that organization. Malformed
   identity or money metadata that cannot be imported safely remains an
   activation blocker and requires human reconciliation plus a new dry-run.
6. Have an independent reviewer inspect the immutable plan and attest the
   provider fence, 100% passive Worker rollout, disabled secondary switch,
   reconciled queue/DLQ evidence, and migration/re-arm evidence. The last item
   requires migration head through `0217` and a read-only primary count of zero
   organizations where `created_at <= auto_top_up_control.paused_at` and
   `auto_top_up_covered_balance_decrease_revision IS NULL`. A `NULL` revision
   remains legitimate for an organization created after the pause. With all
   five facts true, apply the reviewed imports. Apply is replay-safe and
   deliberately leaves the database control in `paused` mode.

   ```sh
   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
     --apply --plan /tmp/auto-top-up-cutover.json \
     --confirm-provider-fence \
     --confirm-passive-worker-100-percent \
     --confirm-worker-switch-off \
     --confirm-queue-and-dlq-reconciled \
     --confirm-migration-and-rearm-baselines
   ```

7. Independently review every applied resolution. Before activation, record
   and verify the primary migration/head, reconciliation watermark, zero
   unresolved imports, and valid non-null organization covered-decrease
   revision baselines. Baseline verification is an explicit human preflight;
   the control CAS does not perform it. Then run the activation phase with the
   same immutable plan and fresh attestations. The repository rechecks the
   watermark, unresolved imports, manual-review organizations, and durable
   attempts before its `paused` to `durable` compare-and-set. The command never
   activates by raw SQL and never changes the Worker switch.

   ```sh
   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
     --activate --plan /tmp/auto-top-up-cutover.json \
     --confirm-provider-fence \
     --confirm-passive-worker-100-percent \
     --confirm-worker-switch-off \
     --confirm-queue-and-dlq-reconciled \
     --confirm-migration-and-rearm-baselines
   ```

   Only after activation succeeds may a human operator enable the exact
   reviewed durable runtime switch.
8. Observe claim, lease, provider-id reuse, credit, terminal-state, and manual
   review logs before declaring the cutover complete.

Record the exact Worker version, database migration/head, provider-key change,
Stripe inventory high-water mark, queue/DLQ counts, control-row transition, and
reviewer approval as deployment evidence. Never put credentials in that record.

## Rollback

1. Move the database control from `durable` to `paused` with the checked-in
   repository-backed rollback phase. This provider-independent CAS is the
   linearizable stop for new claims; it does not call Stripe or change an env
   binding.

   ```sh
   bun --conditions=eliza-source packages/cloud/scripts/admin/auto-top-up-cutover.ts \
     --pause-for-rollback --confirm-database-pause-first
   ```

2. Only after the command reports `controlMode: "paused"`, have a human
   operator disable the secondary durable runtime switch.
3. Keep the recovery-capable durable binary deployed while existing attempts
   converge or enter manual review.
4. Investigate and reconcile before re-enabling charging.

Do **not** redeploy the previous processor as a rollback. It does not understand
the durable attempt ledger or organization re-arm fence and can create a new
provider charge for a balance already covered by a durable attempt.

## Unsafe shortcuts

- waiting a fixed number of minutes instead of fencing the old provider key;
- assuming an omitted Worker secret was deleted;
- activating from a Worker variable without the database transition;
- checking only non-terminal durable attempts while ignoring older provider
  payments or the webhook DLQ;
- choosing a post-epoch inventory lower bound that can omit delayed legacy
  payments;
- using Stripe Search instead of a complete paginated inventory;
- rolling back to the previous direct-charging implementation.
