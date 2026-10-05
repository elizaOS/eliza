# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB
schemas/repositories/migrations, server-side service library, transport types, and
route/auth helpers.

Source-consumed cloud backend library. Tenant scoping, billing arithmetic, database
schemas, migrations, and shared services live here. Apply additive migrations through
the host; never create production tables on a request path.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/shared test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.

Managed Gmail attachment reads retain the explicit grant/message/part identity,
bound provider response sizes, and recheck the grant after the last provider
response before releasing complete attachment bytes. Provider/parser errors must
not disclose message bodies or tokens. Task policy and document extraction remain
host responsibilities.

Use `/auth` for Worker request authentication, `/agents` for durable job admission
and polling, and `/node` for provisioning execution. Public client DTOs belong
to `@elizaos/cloud-sdk/contracts`; Node execution must not enter the agents graph.
Shared exports are explicit. Leaf entries preserve lazy loading and schema ownership;
do not add wildcard exports or consumer aliases that bypass the export map.

Organization plan-change admission atomically consumes the original actor-owned
quote and retains one command across retry keys. Downgrade admission is internal:
it does not dispatch a provider effect or publish a scheduled plan. Expiry can
retire only provably unstarted intents without a live lease; uncertain effects
remain pending until the original outcome is reconciled.

Schedule execution uses ordered `organization_schedule_effects` records (migration
0521) under the original command lease. Each exact request has its own provider
key; configuration requires the original observed create receipt. An observation
can retain evidence after manager revocation but cannot authorize another write.
The journal does not perform provider calls or publish a pending plan; receipt
provenance must be verified by the provider response/event observer before storage.

Original schedule evidence is projected from authenticated Acacia create/update
responses or request-attributed events. The journal reads original scope and first
dispatch time under lock and preserves the first receipt on exact replay. Attribution
is not configured-phase validation: callers still must verify retained terms and
current provider state before configuration, compensation or pending-plan publication.

Downgrade review preflights pinned retained subscription billing terms before invoice
preview. The observer normalizes existing discount/tax/payment references and includes
financial overrides in its digest. Unsupported terms reject instead of being omitted.
Migration 0522 binds normalized subscription settings and customer inheritance to the
original quote in the same transaction. New downgrade intent digests include that
immutable binding; historical version-1 started effects retain read-only recovery.
New admission/dispatch cannot use missing bindings or attach them after consumption.
The dispatcher must still reobserve matching terms and validate phase/default
preservation before provider writes and scheduled-state publication.

Private schedule dispatch now reobserves original terms and catalog before one-time
create/configure writes. Separate stable keys, original response/event recovery and
full-history event traversal preserve unknown outcomes without replay. Phase mapping
retains supported settings, and configuration previews the actual mapped schedule.
Configured-state proof checks original attribution, current phases/defaults and unchanged
subscription/customer terms. These internal helpers do not expose public confirmation. Original configuration
settlement recomputes proof under the locked review and source authority, then atomically
records a pending lower plan, source revision, entitlement projection and immutable command.
The current paid plan and allowance are preserved; no target allowance is granted before renewal.
The one-shot configure dispatcher now performs fresh reads and invokes this finalizer.
Publication also retains the complete verified configuration snapshot on the immutable
command (migration 0526), so later target proof need not depend on expired event history.
Historical commands without that snapshot remain unavailable for target proof; fresh
mutable provider state cannot be attached as original evidence.
Read-only recovery uses original events for a lost response, retains the first receipt,
and never repeats a provider update. Terminal results replay without provider access. Partial-create cleanup uses an independently journaled,
cancellation-preserving release only while configuration has never started. Read-only
recovery uses original events and fresh state, never another release attempt. Proven cleanup
atomically retires its command as FAILED while preserving paid source, projection and allowance;
organization fencing cannot strand that original cleanup. Configured publication requires
an active unfenced organization, original-period evidence and a live original lease.
Command orchestration, public confirmation, renewal settlement and live provider qualification remain required before
product adoption. Cleanup proof currently requires the original billing period and does
not claim renewal-crossing recovery.

The canonical migration journal includes 0520–0525 in order. Scheduling deployment
must use the journal-driven migration runner; loading SQL directly in a test fixture
alone does not establish deployment discovery. The scheduling ledger regression
exercises the same canonical migration loader used by that runner.


Renewal and missed-event recovery retain the original checkout account binding after a
paid organization upgrade. The current price/product come from the applied upgrade's
immutable quote and complete subsequent source revision history, not rotated environment
prices. Unsupported or missing lineage remains unavailable. Scheduled target settlement
and its later paid binding still require the dedicated downgrade renewal path.
