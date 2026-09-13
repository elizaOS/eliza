# Agent failover — recovery contracts

Status: **contract proposal.** Phase 1 is implemented in the working tree; nothing
is enabled, committed, or authorized to run.

Owner boundary: this document defines contracts only. It does not authorize
enabling automatic failover, adding a configuration entry point, or adding a
background caller. `AGENT_BACKUP_RESTORE_FAILOVER_ENABLED=1` continues to throw
in [`agent-backup-restore-coordinator-runtime.ts`](../src/lib/services/agent-backup-restore-coordinator-runtime.ts).
Backup and restore themselves are the implemented contract in
[`agent-backup.md`](./agent-backup.md).

## Problem

A hosted Agent runs on exactly one Docker node occurrence. When that occurrence
stops answering, the Agents on it must move to another occurrence without:

- serving traffic from two instances at once;
- starting a blank Agent and calling it recovered;
- building two copies because two workers noticed the same outage;
- losing or fabricating progress when a process dies mid-recovery;
- silently discarding data written after the recovery source.

## What a failure signal means, and what it does not

Two grounding facts decide everything below.

**Corroboration is a trigger, not proof of death.** A control plane cannot
distinguish a dead node from a partitioned one by reachability. Several signals
agreeing raises confidence; it never establishes death. The vocabulary is
therefore *triggered*, never *confirmed*, and the system must be safe when the
trigger is wrong.

**A truly dead node also loses post-backup data.** The recovery point objective
gap is unconditional: it exists whether the node died or was partitioned, and it
is bounded by the chosen backup, not by the failure mode. There is no failure
mode in which the gap is known to be empty.

## Contract 1 — Safety is authority, not detection accuracy

The old instance and any superseded executor must be refused **at the actual
write, route, and outbound execution boundaries**. A new version or epoch column
in a database is not isolation by itself: if the old instance can still complete
an inbound message, an outbound send, or a state write, it is not isolated
regardless of what any row says.

Phase 1 builds the authority *chain* and nothing more:

- the source instance's real `agent_activation_publications` row is referenced and
  frozen, so the authority being superseded is a recorded fact;
- `cutover` cannot settle until a *restore* publication exists that directly
  succeeds it: same agent, `purpose = 'restore'`, a non-null backup, a strictly
  greater `lifecycle_revision`, and `previous_activation_generation` equal to the
  frozen source generation;
- `completed` cannot be reached without a committed cutover and a fenced source.

**Phase 1 proves the chain is expressible and verifiable. It does not claim the
old instance is isolated.** The three boundary checks are deferred: they live on
gateway, Agent-runtime, and connector paths, and
`authorizeAgentActivationDispatch()` is the shared verification primitive they
should call — as a comparison inside the acting transaction, never as a
pre-check whose transaction has already closed.

## Contract 2 — No automatic merge, and the gap is explicit

- The recovery source watermark is recorded, may only move forward, and is
  required before `restore` may settle — so a blank instance cannot be presented
  as a completed recovery.
- The gap's upper bound comes only from a **committed** cutover: a succeeded
  attempt, or one reconciled as continued. A failed or unresolved attempt does
  not end the gap.
- The possibly-lost message count is tri-state: an exact number, or **unknown**.
  Unknown must never be presented as `0`, and the gap is user-visible.
- Post-backup data is classified before anything is applied:
  - *admitted under the unified authority* — shared-mode writes the platform
    itself accepted — is eligible for an explicit **seal and import protocol**:
    ordered, idempotent, never overwriting the recovered state;
  - *divergent data from an instance that lost authority* is retained and
    **never** auto-applied. Two diverged logs are not reconciled by a recovery.
- Data the old node returns after recovery is preserved, not applied.

## Contract 3 — Capacity belongs to the restore authority

Target capacity is reserved by the restore path —
`reserveAgentBackupRestoreTarget` in
[`agent-backup-restore-operations.ts`](../src/db/repositories/agent-backup-restore-operations.ts) —
which already checks the node record, node id, node incarnation, node history,
`enabled`/`healthy`/`open`, non-provisional capacity, and
`allocated_count < capacity` as one compare-and-set.

A failover operation therefore **never counts capacity**: it records the
references and parks until that admission succeeds. One recovery is counted once.

- Only nodes that already exist and are placeable are eligible. This path never
  calls a provider creation or autoscaling interface.
- A wait is a first-class state carrying a **reason** and a **deadline**, so an
  exhausted wait escalates instead of waiting forever.

## Contract 4 — Orchestration idempotency and effect idempotency are proven separately

Lease expiry does not mean the previous process stopped. It means only that the
platform stopped waiting for it.

- *Orchestration layer*: one non-terminal operation per Agent, compare-and-set
  claims, a lease generation rotated on every claim, every progress write fenced,
  and steps that advance one at a time.
- *Effect layer*: the restore lease, restore operation, replacement attempt, and
  their effect-level unique constraints. This bounds how many artifacts exist,
  which is the property that actually matters.
- Crash recovery reconciles the real effect and its exact identity before
  deciding to continue or retry. A missing journal entry is a reason to inspect,
  never a reason to create a container again.
- An unknown cutover is resolved by **replaying the publication with the same
  identities**, which is idempotent by construction; the identity bundle is
  persisted before the first attempt and never regenerated.

## Contract 5 — The fault scene and the observation policy are frozen

- Observers are a controlled enumeration, and each carries the **policy version**
  it was collected under. A later policy change cannot re-classify old evidence.
- Independence is **declared per source class**, not inferred from labels: two
  platform probes down one network path share a class and cannot corroborate each
  other. A trigger needs two distinct kinds and two distinct classes.
- Cordoning the node and freezing the affected-Agent set happen in **one
  transaction**: the occurrence is locked and re-verified, the node is cordoned,
  and one candidate row is written per Agent whose *current* activation
  publication authorizes it on that occurrence. Enumeration cannot race a
  concurrent placement, and an Agent on another occurrence is never swept in.
- Uncordoning is **not** a failover action. Reopening a node belongs to a
  node-level recovery flow, because the same node may carry other fault records
  or migrations.

## Contract 6 — Cutover is the irreversible boundary

| Cutover state | Allowed |
| --- | --- |
| Not committed | `cancelled`, `failed`, `blocked_no_backup` — and the source may be reopened upstream |
| Unknown | reconcile by replaying the same identities; no cancel, no blind retry |
| Committed | forward only: finish fencing and cleaning up, then `completed`; or `intervention_required` |

`intervention_required` is non-terminal but stops automatic retries: it retains
the target authority, blocks a second operation for that Agent, permits no
rollback, is visible to operators, and can be resumed once the condition is
fixed. Post-cutover attempts are bounded; exceeding the bound parks the operation
there. `completed` is never claimed before the old instance is fenced.

## Contract 7 — The switch stays hard-off

Phase 1 adds internal capability and tests only.

- No new environment variable, configuration entry, or feature flag.
- No background caller, cron entry, or worker wiring.
- `AGENT_BACKUP_RESTORE_FAILOVER_ENABLED=1` keeps throwing, so no configuration
  can run any of this.

## Ordinary placement reserves the exact occurrence it selected

Cordoning and freezing hold the node row, re-verify the occurrence, cordon, and
enumerate the Agents whose current publication authorizes them on that
occurrence — all in one transaction. That stops *later* selections. It does not
stop a placement that was already decided, so the ordinary create path was the
remaining way a container could land on a cordoned node.

Both production create paths now take their slot with a compare-and-set bound to
the exact occurrence they selected: same record, same handle, same incarnation and
history generation, still enabled, healthy and placeable, not provisional
capacity, and below the ceiling. A node that was cordoned, replaced, re-attested,
or filled between selection and reservation is refused instead of used.

- `DockerSandboxProvider` raises `DOCKER_PLACEMENT_RESERVATION_LOST`.
- `HetznerContainersClient` fails the intent with `no_capacity`.

Two details make the reservation trustworthy rather than decorative:

- It is taken **immediately before the first node-side effect**, after tenant,
  VPN, environment and SSH-client preparation. Anything that can throw runs
  before the slot is held, so a failure there cannot leak it, and the existing
  rollbacks cover everything after it.
- Rollback releases the **same occurrence** the reservation matched
  (`releaseExactNodeAllocation`). Releasing by the reusable handle could decrement
  a replacement record's count. A refused release is logged as needing a recount
  rather than treated as success, because the alternative is a silently
  over-committed fleet.
- **The placement intent is persisted before the first node-side effect**: the
  node record, incarnation, history generation, container name, and the fact that
  a reservation is held. A failure that cannot be cleaned up therefore leaves a
  row a reconciler can act on, instead of a reservation with no owner.
- **Cleanup precedes release, and absence is settled by name.** On failure the
  container is removed first, and the slot is released only once its absence is
  proven. Two cases are distinguished:
  - the create command was never submitted, so no container can exist and the slot
    is released directly;
  - the create was submitted, and absence is proven either by a successful
    `docker rm` or by a name-exact `docker ps -a` filter returning nothing.
  `docker rm` fails both when teardown fails and when there was nothing to remove,
  so its error alone is never treated as proof of either state. Releasing first would hand
  the slot to another workload while a started container may still be running,
  which overcommits the node. When removal cannot be proven, the slot is
  deliberately retained and reported: the row's locator already names the node and
  container, so a later reconciliation can finish the cleanup and release it.
- A failure to release, or to mark the intent failed, is caught and logged rather
  than allowed to abort the remaining steps: a teardown failure must never mask
  the create error that caused it.

What this closes:

- a container can no longer land on a node cordoned after selection, which is
  what produced orphans outside the frozen set;
- two concurrent placements can no longer both pass a read of free capacity and
  then overfill the node;
- provisional autoscaler capacity is no longer schedulable authority on this
  path, matching the restore path.

`decrementAllocated` remains for paths that never took an exact reservation
(replacement cleanup and the legacy seed fallback); it is no longer used to
release an exact reservation.

## Constraint discovered during phase 1

[`agent-backup-restore-api-boundary.test.ts`](../src/db/agent-backup-restore-api-boundary.test.ts)
allowlists, per symbol, exactly which production files may reference each restore
entry point, and how many invocation sites may exist. `acquireAgentBackupRestoreLease`,
`openAgentBackupRestoreOperation`, `claimAgentBackupRestoreOperation`,
`reserveAgentBackupRestoreTarget`, `recordAgentActivationPublication`, and
`authorizeAgentActivationDispatch` are all covered.

Consequence: **a failover module cannot call them.** Phase 1 therefore creates the
reference columns, foreign keys, and guards, and the restore runtime — already on
the allowlist — performs the calls and records the result. Moving a call site into
failover would require deliberately amending that allowlist, which is an
architectural change rather than a mechanical one.

Separately observed, out of scope here: `replacement-cleanup.ts` reserves capacity
by `node_id` alone and without the `capacityProvisional` exclusion, unlike the
restore path. That is a live-path defect worth its own issue.

## Resource constraint

Automatic failover must not create production or staging provider nodes, call a
provider creation interface, or trigger autoscaling. Tests may create local
ephemeral PostgreSQL/Docker containers for concurrency verification; they must not
connect to or modify production infrastructure.

## Terminal states must not strand restore capacity

A capacity wait that expires while the operation still references a restore lease
does not go terminal: it moves to `restore_release_required`, and the guard refuses
`failed`/`cancelled`/`blocked_no_backup` until the slot is provably back.

**Releasing the restore lease is not returning the capacity.** The lease release
only clears `released_at`; the target slot comes back in the restore path's
cleanup-finish compare-and-set on `docker_nodes.allocated_count`. So where a
replacement attempt is referenced, the terminal transition additionally requires
that attempt's proven cleanup (`cleanup_proven_at` and `cleanup_receipt_digest`),
which is the only receipt that says the slot was returned. Where no attempt is
referenced, the reservation never happened — reserving the target and starting the
replacement intent are one transaction — so the released lease is sufficient. A
runtime that is allowed to call the restore APIs performs the release, then the
operation fails honestly with an explicit exhaustion code. Without this the
cancelled recovery would keep a target slot with no owner.

The restore reference itself may also be rebound — a stall longer than the
restore lease lifetime would otherwise strand the operation forever. Rebinding is
allowed only **before** any cutover intent exists and only when the previous
lease is provably dead (released or expired), so a live holder is never displaced;
the new authority is re-verified in the same statement.

## Operating an intervened failover

`intervention_required` has a controlled way in and a controlled way out.
`finishOperation` parks there after a committed cutover refuses a terminal
failure, and once bounded post-cutover attempts are exhausted. `resumeFromIntervention`
requires an operator identity and a reason, appends them to
`agent_failover_operator_actions` (append-only, guarded), resets the post-cutover
attempt budget, and returns the operation to `running` for the normal claim path.
The trail is a separate table precisely because an operation column that the next
resume overwrites is not an audit record.

The caller is the authorization boundary: this module records the audit trail but
does not authenticate the operator or decide who may resume. A route that exposes
resume must enforce its own permission check, and the reason is retained for the
incident record.

## Phase-1 scope (implemented, not enabled)

1. `triggered` semantics instead of `confirmed`.
2. Observation policy version and a controlled observer enumeration with declared
   independence classes.
3. Atomic cordon plus a frozen candidate set derived from activation publications.
4. Steps that advance only to the adjacent successor, after the current step
   succeeded — enforced in the repository and again in the guard.
5. The source publication referenced and frozen; the target must be a restore
   publication that directly succeeds it with a greater `lifecycle_revision`.
6. Restore lease, operation, and replacement attempt referenced; capacity never
   counted here.
7. Cutover cancellable before commit; forward-only or `intervention_required`
   after.
8. Unknown cutover resolved by idempotent replay of the persisted identity bundle.
9. The RPO gap ends only at a committed cutover.
10. Wait states are bounded in fact, not only in shape: the claim paths refuse an
    operation whose deadline has passed, and `escalateExpiredWaits` fails it with
    an explicit exhaustion code.
11. The declared observer class is pinned in the database, so SQL cannot pass a
    platform probe off as an independent failure domain.
12. A reconciled-continued cutover clears the same publication, backup,
    generation, revision, container, and node-occurrence checks as a direct
    success.
13. The cutover identity bundle is frozen before the publication exists, so a lost
    publish response is resolved by replaying the same identities.
14. A withdrawn trigger and a concurrent open cannot race: the withdrawal locks the
    event row before checking for outstanding work, and the operation insert takes
    a share lock on the same row.
15. Every wait and scan parameter is a bounded integer.
16. Every non-terminal query reads one shared status list, so a newly added state
    cannot be missed by the withdrawal, active-operation, or claim checks.
17. Both production create paths reserve their slot by exact occurrence, adjacent
    to the first node-side effect, and release it by the same occurrence.
18. The capacity-release proof is read from the restore authority rather than from
    an optional column: if a reserved attempt exists for the restore operation and
    lease, terminal failure requires that attempt's proven cleanup, and the
    attempt is attached once under a live lease. Omitting the id cannot skip the
    check.
19. PGlite proves the state contracts. Real PostgreSQL proves locking, leases, the
    freeze, and the claim races across independent sessions — all eight
    concurrency tests pass against a real instance.

## Explicitly not claimed

- Detection is not made reliable by these contracts, and is not required to be.
- Isolation is not achieved by writing an authority value (Contract 1).
- The RPO gap is not closed, and post-backup data is not merged.
- Recovery is not supported onto capacity the platform does not already have.

## Open decisions

1. Which component performs the boundary comparison for each of the three actions
   in Contract 1, and how the comparison joins the acting transaction.
2. Who owns the seal-and-import protocol for shared-mode data, and its ordering and
   idempotency keys.
3. The severity policy behind the wait deadline and the escalation receiver.
4. Whether the message-count tri-state is computed during phase 2 or reported as
   `unknown` until the trajectory store can answer it.
