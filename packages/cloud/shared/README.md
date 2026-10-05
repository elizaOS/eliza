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
This review check alone does not bind a create effect: the dispatcher must reobserve,
persist the original retained-term binding and validate phase/default preservation.
