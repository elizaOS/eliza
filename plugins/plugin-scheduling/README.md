# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic `ScheduledTask` state
machine **and** the always-loaded runtime primitive that HOSTS it.

Core TaskService drives the clock; this plugin owns ScheduledTask storage contracts,
state transitions, registries, and execution. Edge hosts inject the SQL executor through
the package root. Connector delivery uses typed DispatchResult and must not record failed
delivery as success.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-scheduling build  # build
bun run --cwd plugins/plugin-scheduling test   # tests
```

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

Host-owned activity anchors may declare `consumption: "host_claim"`. Automatic admission, execution preparation and mutation hooks preserve owner control metadata, and atomic claim expectations reject stale writes as `raced`. Manual fire does not consume automatic admission. These hooks use the existing runner and store; they do not introduce another scheduler.
