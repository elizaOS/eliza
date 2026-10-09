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

Network turns retain a server-owned project marker but use the account's original
Personal assistant and canonical room. `NETWORK_PERSONAL_CONTINUITY_ENABLED` is
absent by default: Network Cloud turns and delivery remain disabled until legacy
Network history, todos and reminders are inventoried and any migration has durable
receipts. Enabling this flag is not evidence that migration is complete. The old
Network address is exposed only by `legacyNetworkPersonalSharedAgentId` for inventory;
this candidate performs no alias, import or deletion. This is an inbound identity candidate. Account-bound Network delivery is
unimplemented and disabled, even with the flag enabled. A
Dedicated lookup alone cannot prevent cutover/deletion racing provider dispatch.
The canonical conversation owner must hold admission through provider acceptance
and history append before this delivery path can be enabled.

The continuity flag gates Cloud turns and direct delivery only. It does not gate
the gateway's deterministic handled replies. Those replies can precede Cloud
account resolution and have no Cloud history append. First-text Cloud account
creation and complete canonical history for handled turns remain unqualified.
