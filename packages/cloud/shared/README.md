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

Network turns retain server-owned app authority while using the account's original
Personal assistant and canonical history. `NETWORK_PERSONAL_CONTINUITY_ENABLED`
defaults off pending legacy history/todo/reminder inventory, reviewed migration
receipts and staging qualification. This code creates no alias or migration.

The canonical conversation owner persists delivery intent before gateway I/O,
serializes sends with cutover/deletion, stores verified provider receipts before
history append, and replays completion without resending. Unknown outcomes permit
only read-only receipt recovery through the existing room alarm. Pending delivery
fences lifecycle changes until resolved. Dedicated ownership refuses before send.

Gateway handled turns require authenticated channel provenance and a signed service
admission. Eligible first contacts use the existing phone account owner and record
inbound plus accepted replies in that same history. Proactive/relay traffic never
creates accounts. Ineligible policy acknowledgements create no Cloud account or
history. STOP remains line-wide; a newer scoped START permits only its own app.
