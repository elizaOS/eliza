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
This foundation release does not expose an activation command. The reviewed,
dry-run-first operator command for inventory, quarantine resolution, and the
guarded control transition must ship with the durable processor before any
cutover is attempted. Direct SQL is not a supported activation procedure.

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
4. Page through Stripe PaymentIntents using the authoritative list API for the
   full cutover interval. Do not use eventually-consistent search as the
   inventory. Reconcile every `auto_top_up` intent created before the provider
   fence, including intents whose HTTP response was lost.
5. Drain and inspect the Stripe webhook queue and dead-letter queue. Successful
   intents must have exactly one matching credit; canceled intents must not have
   a credit; processing, malformed, or otherwise ambiguous intents remain
   quarantined with auto-top-up disabled for that organization.
6. In the primary database, verify the reconciliation watermark, zero
   unresolved imported payments, valid organization re-arm baselines, and no
   unresolved durable attempt that could overlap activation.
7. Transition the database control from `paused` to `durable` with its guarded
   compare-and-set operation. Only after that transaction succeeds may the
   exact reviewed durable runtime switch be enabled.
8. Observe claim, lease, provider-id reuse, credit, terminal-state, and manual
   review logs before declaring the cutover complete.

Record the exact Worker version, database migration/head, provider-key change,
Stripe inventory high-water mark, queue/DLQ counts, control-row transition, and
reviewer approval as deployment evidence. Never put credentials in that record.

## Rollback

1. Move the database control from `durable` to `paused`. This is the
   linearizable stop for new claims.
2. Disable the secondary durable runtime switch.
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
- using Stripe Search instead of a complete paginated inventory;
- rolling back to the previous direct-charging implementation.
