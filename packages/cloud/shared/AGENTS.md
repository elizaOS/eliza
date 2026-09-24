# @elizaos/cloud-shared

Shared backend code for Eliza Cloud: billing arithmetic, Drizzle DB schemas/repositories/migrations, server-side service library, transport types, and route/auth helpers.

Private backend package: browser consumers use public SDK contracts. Preserve tenant isolation, billing idempotency, and ordered database migrations.

Build, test, and setup: [README.md](README.md).
