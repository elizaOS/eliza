# #9686 tenant DB placement claimer evidence

## What changed

Added a PGlite-backed test that drives `SqlTenantDbProvisioning.provisionForApp`
twice for the same app using the real
`appDatabasesRepository.claimTenantDbPlacementForApp` implementation. The test
creates the minimal `apps`/`app_databases` schema, applies the real
`0140_tenant_db_clusters.sql` and
`0151_app_database_tenant_cluster_placement.sql` migrations, and asserts:

- both provisions return the same `clusterId`,
- the durable app placement points to that cluster,
- `tenant_db_clusters.database_count` is `1` after the first provision and
  remains `1` after the retry.

The tenant DDL itself is intentionally faked here; this test is about the
production placement claimer and slot-accounting invariant. The existing real
Postgres integration suite continues to cover tenant DDL isolation.

## Verification

- `placement-claimer-test.log` — new PGlite real-claimer test: 1 pass.
- `tenant-db-provisioning-unit.log` — existing provisioning unit suite: 8 pass.
- `biome.log` — focused Biome check succeeds.
