# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic ScheduledTask state machine, registries, runner, and the spine→reminders ports. See CLAUDE.md for the package contract.

> **Vocabulary:** a `ScheduledTask` record is a **scheduled item** (reminder / check-in / follow-up / …), distinct from a core **task**, an engine **workflow**, and an orchestrator **coding task**. The runner owns no timer — it is ticked by the single core `TaskService` clock via the `LIFEOPS_SCHEDULER` task.


Hosts may supply `executionBoundary` through the runner dependencies. It receives
an existing scheduled item and an `execute` callback spanning the fire claim,
dispatch, final persistence, and awaited follow-up work. A host can deny admission
before the claim or retain a durable operation until `execute` finishes. The host
must invoke the callback at most once and await it; rejected execution propagates
to the host so uncertain effects can remain available for reconciliation. The
atomic fire claim also checks the metadata observed by admission; a concurrent
metadata change returns `raced` so the next attempt obtains fresh admission. Task
creation and editing are separate persistence operations and are not covered by
this execution boundary.

### SQLite runtime storage

The standalone host's explicit SQLite mode selects scheduling's native durable
record store in the same agent database. The host rewrites the SQL bootstrap
dependency and omits the PostgreSQL Drizzle schema only for plugins that declare
an implemented SQLite backend. Scheduling initializes its own versioned record
schema before starting the runner. A direct `AgentRuntime` embedder must likewise
supply the SQLite bootstrap dependency and omit scheduling's PostgreSQL `schema`.

Claims, apply intents, receipts and state logs use the adapter's durable
transactions. Concurrent workers in one agent process serialize through the
same connection; another process cannot open the exclusively owned database.
After restart, the records and receipt replay state remain available. Domain
queries currently scan records; benchmark the intended per-agent history before
large deployments. No PostgreSQL data import or shared/dedicated cloud cutover
is implemented by this backend. Personal-assistant and health repository ports
remain separate work; their PostgreSQL schemas are still rejected by SQLite.

SQLite files, WAL and backups require the deployment's encrypted filesystem.
SQLite alone provides neither encrypted storage nor a tamper-evident audit log.
