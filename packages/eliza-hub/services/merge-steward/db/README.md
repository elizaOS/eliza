# Merge Steward Database

`migrations/001_steward_runtime.sql` is the base production Postgres schema for
runtime state. `migrations/002_postgres_store_payloads.sql` adds full payload
round-tripping for the Node adapter plus the generic event log used for webhook
delivery idempotency. `migrations/003_agent_claims.sql` adds agent work
claim/lease records for repo resources such as PRs, branches, paths, packages,
tasks, and queue items. `migrations/006_agent_identity_registry.sql` adds the
steward-owned allowed-agent identity registry used by strict live merge policy.
`migrations/007_work_items.sql` adds durable Eliza Work items.
`migrations/008_work_cycles_modules.sql` adds Eliza Work cycles/modules and
indexed `cycle_id` / `module_id` links on work items for progress snapshots.
`migrations/009_work_views.sql` adds durable saved views for dashboard and
spreadsheet-style Eliza Work planning surfaces.
`migrations/010_work_pages.sql` adds durable work pages for agent plans,
runbooks, release notes, decisions, specs, and notes linked to work items,
cycles, modules, tasks, issues, and PRs.

It encodes the core production invariants:

- one running queue item per `(repo, target_branch)` lane
- unique Forgejo/GitHub webhook delivery IDs per provider
- one run node per `(run_id, node_id, iteration)`
- one attempt per `(run_id, node_id, iteration, attempt)`
- append-only run events with unique per-run `seq`
- run-scoped approvals, human requests, and external signals
- one agent claim per `(repo, resource_kind, resource_id)` with renew/release
  timestamps and owner metadata
- active registered agent ids are steward-owned authority for strict agent PR
  merge policy and mutating OIDC agent actions
- work item planning links use indexed `cycle_id` and `module_id` columns while
  preserving full normalized objects in `payload_json`
- saved views preserve structured filters, layout, columns, visibility, and
  full normalized payloads for dashboard reconstruction
- work pages preserve Markdown planning context with indexed planning and
  Forgejo links while keeping full normalized payloads for dashboard/search
  reconstruction
- work intake is a computed preview over queue items and durable work items;
  confirmed apply writes normalized work item rows instead of introducing a
  separate intake table

Multiple steward replicas must use database transactions and row locks around
claim/recovery operations. The expected production claim flow is:

1. select candidate queue items with `FOR UPDATE SKIP LOCKED`
2. update one item to `running`
3. rely on `steward_queue_items_running_lane_idx` to reject lane races
4. create or resume the associated `steward_runs` / `steward_attempts` rows in
   the same transaction

Agent work claims use the same pattern at finer granularity: lock the existing
claim by id or repo/resource, reject active unexpired leases owned by a different
agent, and preserve the existing row id when a caller supplies a custom claim id.

The Node service uses `PostgresQueueStore` when `DATABASE_URL` is set. Without
`DATABASE_URL`, it falls back to `JsonFileQueueStore` when `QUEUE_STORE_PATH` is
configured. Do not run multiple steward replicas against the JSON store.

Apply migrations with:

```sh
DATABASE_URL=postgres://... npm run migrate --prefix services/merge-steward
```

The runner records applied files in `steward_schema_migrations` and rejects
checksum drift for already-applied migrations.
