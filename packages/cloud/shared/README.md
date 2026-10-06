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
an active unfenced organization, original dispatch evidence and a live original lease.
Command orchestration, public confirmation, renewal settlement and live provider qualification remain required before
product adoption. Cleanup proof currently requires the original billing period and does
not claim renewal-crossing recovery.

The canonical migration journal includes 0520–0527 in order. Scheduling deployment
must use the journal-driven migration runner; loading SQL directly in a test fixture
alone does not establish deployment discovery. The scheduling ledger regression
exercises the same canonical migration loader used by that runner.


Renewal and missed-event recovery retain the original checkout account binding after a
paid organization upgrade. The current price/product come from the applied upgrade's
immutable quote and complete subsequent source revision history, not rotated environment
prices. Unsupported or missing lineage remains unavailable. The scheduled renewal path
proves the retained original schedule terms and compatible lifecycle before atomically publishing
the paid lower plan and allowance. Later renewals retain its reviewed price through the
paid target revision and original grant. Distinct deliveries of an already-funded invoice
acknowledge immutable payment records without changing current source, entitlement or
spendable balances. Positive captured renewals reconcile invoice/item discount allocations
and inclusive/exclusive tax against the original catalog base and exact captured total.
Adjustment attribution is included in immutable grant proof; unadjusted grant digests remain
compatible. Renewals also support canonical invoice credit application, captured remainders,
and fully discounted or credit-settled zero-due invoices without fabricated payments.
Credit authority requires complete customer balance history with a stable reobserved head,
matching invoice application and exact starting/ending balance arithmetic. Reversals,
credit notes, deferred debit balances and ambiguous applications remain unavailable.
Initial Checkout retains its separate positive-payment contract.

The internal credit-note observer reads complete Acacia note/line pages twice and
rechecks the retained merchant and invoice. It retains normalized financial fields
and an observation digest, excluding private text and document URLs. Changed,
foreign, incomplete or unsupported records fail explicitly. This read-only helper
does not establish an atomic provider snapshot, reconcile refunds/balance entries,
authorize allowance or relax the existing settlement guards; entitlement policy
and transactional publication remain required before integration.

The linked disposition observer additionally checks original capture, complete
refund history, canonical refunds and merchant debits, and note-bound customer
credit postings. Complete note observations bracket two linked-evidence reads.
It rejects unverified/out-of-band or changed allocations; a historical customer
credit posting is not the current available balance. This remains read-only and
does not choose recurring-allowance policy or publish entitlement changes.

Failed owned target invoices now use the existing dunning lifecycle through webhook and
missed-event recovery. Publication rechecks original configured lineage, target schedule,
subscription, customer and failed invoice under the organization lock. Dunning preserves
the previous paid plan/period and pending target without granting allowance; subsequent
captured payment proves the contiguous dunning history before settling the lower plan.
The original grace window cannot be reset by a later revision.

Target terms survive a verified schedule release/completion through the retained original
snapshot and explicitly checked lifecycle changes. Released targets can settle within their
original invoice period. Historical grants expire atomically through the existing ledger;
historical target publication combines original captured invoice and separate live
compatibility proof in the existing receipt transaction. It advances only the original
paid interval, retains later dunning from the next unpaid boundary, and never grants
current-period credit from an old payment. Chronological recovery preserves adjacent invoice order; terminal-source accounting remains open.

Captured renewal payment proof is independently reusable for an exact retained invoice
interval, price, owner and amount. It does not read or synthesize current subscription
state. Current renewal publication still requires its live period/latest-invoice checks;
historical publication must separately preserve ordered source authority and current dunning.

Scheduled target observation separates compatible live state from original-period
settlement. A released/completed schedule can have a later active, past-due or unpaid
subscription without proving any invoice paid. Original settlement still requires its
exact interval and latest invoice; historical callers must independently prove captured
payment, preserve later debt and publish source/allowance in order.

Adjacent ordinary historical renewals use independent live compatibility and captured
payment proof after the scheduled target settles. Each transaction records only the
next proven paid interval, expires its old allowance and retains later observed dunning.
Cancellation commands keep their stricter captured-item/period authority. Ordinary
renewals currently retain item identity; verified item-replacement history remains
required before compatible replacements can enter missed-period recovery.

Missed-period recovery traverses complete authenticated subscription invoice pages
within the claim's database-time creation boundary before selecting the unique invoice
starting at the stored paid period end. It rejects ambiguity, overlap, incomplete
history and draft/void gaps, then retrieves canonical payment/live objects again. Discovery
precedes active/dunning routing; the existing leased transaction settles one adjacent
period per attempt and subsequent scans continue history. Provider read failure never
authorizes a partial match or a jump to the newest invoice.

An adjacent open/uncollectible historical invoice is lifecycle-only evidence. Recovery
rechecks owned failed-invoice, retained catalog/account and compatible past-due/unpaid
live state under the organization lock, retaining the original paid period and pending
plan without allowance. Later captured payment uses the existing chronological owner.
Draft/void gaps and an active live subscription with old debt remain explicit uncertainty.

Original configuration proof is separate from current-period publication. It reconstructs
the request from authenticated creation and immutable retained terms, checks the original
review/dispatch window, and requires a saved pre-boundary response or an authenticated
pre-boundary event. Recovery time stays current; retained terms are not fabricated live
observations. Late publication composes that original proof with fresh target lifecycle,
owner/catalog/period compatibility and the original locked source/lease. It persists the
original snapshot, never the later live schedule. Migration 0527 preserves the original
dispatch window, every paid source field and entitlement deadline, and forbids allowance
postings. Pending publication does not fund the target or revive an expired entitlement;
chronological invoice reconciliation still owns payment and dunning. Recovery depends
on available authenticated original evidence, not indefinite provider event retention.

The private downgrade command coordinator now composes original quote admission,
leased creation/configuration, authenticated original-event recovery and proven
partial-create cleanup. A started effect is never dispatched again. Same-quote
retries keep the original command even with another retry key; occupied leases
return durable status. Session failure survives cleanup, and status reads perform
no provider work. Authenticated confirmation/status routes and SDK methods now expose this coordinator.
The existing Stripe maintenance process recovers original schedules in bounded,
leased batches. It observes started effects, expires unstarted intents, and can
clean up a proven unconfigured creation after review expiry. It never creates or
configures a schedule. Recovery retains scoped incidents with backoff and resolves
them atomically with the original terminal command, without borrowing a manager
session. Native/product adoption and retained-adjustment payment authority still
need integration and qualification.

Cancellation, reviewed resumption and cancellation-event reconciliation resolve the
retained purchased/current paid-plan binding instead of newly configured catalog IDs.
Purchased account identity is retrieved before provider work and checked again against
locked retained authority at publication. Legacy subscriptions keep catalog validation;
configured pending-plan cancellation additionally reconstructs immutable downgrade evidence.
It sends one idempotent schedule update preserving the paid phase, removes the future
phase, and clears the pending plan only after canonical verification. Lost responses
remain read-only recovery. Cancellation/resume writes disable SDK network retries;
the original command owns uncertainty for ordinary subscriptions and schedules.
Resume requires a fresh schedule preview and preserves
the current plan without restoring the discarded downgrade. Webhook and active-period
cron observations validate the same retained schedule; provider and device qualification
remain separate from controlled integration tests.

Account management resolves pending-plan cancellation eligibility from the same
immutable schedule proof as command admission in its primary read transaction.
The scheduled target alone grants no control; actor/state gates and submission
revalidation remain authoritative.

New organization renewal grants retain a versioned original invoice/line/payment
identity and settlement digests in the existing grant metadata, atomically with
publication. Replay validates and preserves that first record; legacy grants are
not backfilled from current provider objects. An unknown legacy merchant remains
null. This identity record is not complete adjustment evidence or refund policy.
New grants also retain the normalized original invoice's financial fields, bound
to that identity, without private provider descriptions or metadata. Replay keeps
the first details and never backfills missing historical records. Complete payment,
credit-ledger and subsequent adjustment evidence remain separate requirements.

New grants additionally retain normalized original PaymentIntent/capture fields and,
for credit-bearing invoices, the complete observed customer-balance history. Replay
revalidates this evidence against the original invoice and settlement digest without
provider reads or historical backfill. Private payment and balance descriptions are
excluded. These original observations do not establish current refund health or
implement later adjustment policy; subsequent evidence must remain separate.

The private retained-renewal adjustment adapter derives provider scope from the
original grant authority, invoice and settlement record. Missing historical evidence
or merchant authority fails before provider reads; later invoice totals, balances
and replacement captures cannot rewrite the original grant. Its output binds the
subsequent observation to the original evidence digests. The caller must load the
original paid source revision and separately authenticate, revalidate and persist
the observation; no correction policy or allowance publication is implied.

Migration 0528 adds append-only, predecessor-checked observations anchored to the
existing renewal grant and allowance period. The private repository reloads the
original paid revision, reads providers outside locks, then rechecks organization
fences and the journal head before append. A stable request UUID replays the first
saved result without provider reads. This records evidence only: callers still
own authentication, orchestration and explicit correction policy; no allowance
posting or public adjustment endpoint is enabled.

Migration 0529 adds grant-scoped observation claims with database-time leases,
generations, immutable attempt receipts and bounded failure backoff. Discovery
uses original funded periods without excluding terminal subscription history.
Journal append, completion and next-due scheduling commit together; expired
workers cannot publish. These private primitives do not enable automatic polling,
change allowance policy or reconstruct missing legacy evidence.

The existing Stripe maintenance endpoint now invokes bounded original-grant
adjustment observation recovery independently of current-subscription recovery.
It reuses the read-only absolute-deadline provider client, records grant-attributed
incidents in the existing billing operations store, and backs off unavailable
legacy evidence without reconstruction. Lane infrastructure failures remain visible;
recorded observations never post allowance corrections. Deploy migrations through
0529 before enabling the updated maintenance handler.

Original Acacia invoice-paid events with debit balances are retained under their
existing platform billing receipt before funding recovery. Migration 0530 adds
immutable, tenant-bound observations; atomic receipt insertion preserves exact
replay and rejects late backfill. These records are not payment proof: deferred
collection/allocation and allowance publication remain unavailable until separately
qualified. Current provider invoices never replace original signed event bodies.

Private retained-invoice discovery includes historical and terminal subscription
sources without requiring a funded period or current item. Claims reuse the
existing receipt lease/counter, primary database clock and capped retry delay;
organization deletion and billing fences are rechecked after lock acquisition.
The selector/claim boundary does not run provider reads or publish allowance.

Migration 0531 retains versioned balance observations under the original invoice
receipt. The private observer reads outside locks, then rechecks the organization,
source fence and live receipt lease before atomic append and retry release. The
claim token replays its first durable result without touching a newer lease.
Observations never mark financial application complete or grant allowance. The
existing authenticated Stripe maintenance endpoint invokes an independent lane of
at most five original receipts under one 20-second read-only provider deadline.
Expected observation failures retain receipt-attributed incidents before retry
release; database failures fail the lane visibly. Deploy migrations through 0533
before enabling this handler. Migration 0532 preserves earlier balance rows and
admits the collecting-capture shape under the same immutable journal and receipt
lease. Only retained original positive starting balance and amount due select
capture reads; later provider pointers cannot promote a deferred original.
Capture failures remain retryable incidents and never fall back to balance-only
success. Complete captured payment evidence does not allocate historic debt or
authorize allowance; allocation proof and policy remain open.

The private `traceOriginalInvoiceDebt` calculation traces full-debit carry chains
through retained originals and complete ledger movements. It preserves each
invoice's net new contribution, subscription and original period; a carried
starting balance is never counted as new debt. Repeated equivalent events do not
duplicate components. Missing/conflicting originals, reversed or partial
applications, unsupported credit movements and broken arithmetic fail explicitly.
This is provenance evidence only: provider-shape qualification, fresh capture and
original-invoice observations, durable attribution, source fencing and allowance
policy remain required before financial publication. The original-invoice maintenance lane now uses this calculation through the
combined current-observation path described below.

`observeOriginalInvoiceDebt` brackets two current reads of every traced original
with repeated authenticated collecting-capture observations. Current projected
collector and original invoice fields must still equal retained facts. It reuses
the read-only absolute-deadline transport with four concurrent component readers,
awaits outstanding readers on failure, and returns only a complete, consistent
observation. Provider changes and private response errors reject. Migration 0533 retains this combined evidence in the existing receipt journal.
Publication rechecks original receipts and locks the billing fences of all
contributing subscriptions; unrelated sources do not block it. The existing
maintenance lane records unsupported traces and missing originals as incidents.
Earlier balance/capture versions remain immutable and replayable. This does not
grant allowance; repeated reads are not an atomic provider snapshot. Deploy
migration 0533 before the updated maintenance handler.

The private original-invoice commercial resolver binds an explicitly selected immutable
source revision to the retained invoice item and interval, original purchased merchant,
and purchased or reviewed paid-plan price/product. It never falls back to deployment
prices or today's plan. The complementary commercial-origin resolver uses a named completed checkout, paid
upgrade or originally configured downgrade when the invoice interval has no paid
revision. It validates the actual command revisions and retained review/snapshot,
preserves the signed invoice interval, and never synthesizes a paid source. Missing
purchase/review authority remains unavailable. These digests record nominal terms only: receipt ownership,
current collection evidence, policy decisions, fences and atomic financial publication
remain separate requirements. Reading terms never changes lifecycle or allowance.

Receipt-owned commercial selection now loads its original invoice from storage,
checks organization/source restrictions, and inspects complete bounded applied
origin history. Matching origins must agree on nominal terms; all matches are
retained deterministically. It can join the caller's transaction for publication
revalidation, but writes no decision or allowance and enables no maintenance lane.
