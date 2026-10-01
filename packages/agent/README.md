# @elizaos/agent

Standalone agent host and HTTP/WebSocket backend around the elizaOS runtime.

Hosts explicitly compose core, assistant, storage, and model plugins. Start from the
repository root with `bun run start`; use `bun run dev` for the app and API together.
Configure providers and connectors through the host configuration; never expose host
secrets to ungranted agents.

Import public runtime, service, role, and operation APIs from `@elizaos/agent`.
Agent code imports core APIs and catalog maps through `@elizaos/core`.
`RegistryClientPluginInfo` and `RegistryClientSearchResult` expose the underlying
registry shapes; `RegistryPluginInfo` and `RegistrySearchResult` retain the
plugin manager's extensions. The roles plugin is exported as `rolesPlugin`.

`SqliteInteractiveTaskStore` is available from
`@elizaos/agent/services/interactive-task-store`. Supply a private host-managed
SQLite connection with FULL or EXTRA synchronization. The host retains database
location, encryption and lifecycle ownership. After exclusive startup, call
`recoverOwner` for the authenticated owner before accepting task commands; it
pauses unfinished work and marks dispatched outcomes unknown. Persist a dispatch
transition before any effect, then independently revalidate at the actuator.
This journal does not execute actions or authorize browser access.

`InteractiveTaskRuntime` and `createInteractiveTaskHandler` have matching
`services/interactive-task-runtime` and `services/interactive-task-http` exports.
The runtime commits dispatch before entering the host actuator and cancels
pending work on Pause/revoke. The HTTP handler accepts only start/status and
pause/cancel/resume; host callbacks resolve authenticated ownership and authorized
goal references. Mount it behind the host's normal origin/transport protections.
Account changes must revoke the old runtime, and the native actuator must recheck
page, input revision and authorization immediately before an effect. The handler
never accepts client observations, execution commands or outcome receipts.

Actuators may implement `quiesce` to remove transient host UI. After synchronous
Pause/cancel/revoke, hosts must await `runtime.settle()` before reporting cleanup
complete or replacing the runtime. The HTTP handler does this automatically.
Unconfirmed cleanup returns `TASK_CLEANUP_UNCONFIRMED`; a later status read retries
cleanup only, without repeating the task transition or browser action.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/agent build  # build
bun run --cwd packages/agent test   # tests
```

Retain real end-to-end scenarios exercising host, transport, and persistence.
The package test, test:e2e, and test:integration commands share that suite;
do not reintroduce removed unit, mock, smoke, or source-inspection tests.

Run the native coding CLI end to end with configured provider credentials:

```bash
BENCHMARK_NATIVE_CODING_E2E=1 BENCHMARK_NATIVE_MODEL=<model> \
  bun --conditions=eliza-source node_modules/vitest/vitest.mjs run \
  --config packages/agent/vitest.config.ts packages/agent/test/benchmark-coding-live.test.ts
```

This uses a real provider and isolated Git fixture, verifies executed WRITE/SHELL
actions and Python tests, and requires clean process shutdown. Receipts are saved
under `test-results/agent-native-coding/`. Configure provider-specific model
settings to match `BENCHMARK_NATIVE_MODEL` when overriding the shared defaults.

Benchmark JSON separates `turn_completed` from the optional planner assessment
`request_fulfilled`, and preserves `action_results` and `effect_receipts`, including
failed attempts that were later recovered. An explicit unfulfilled assessment
fails the CLI. These fields are execution evidence; benchmark graders must still
verify the requested outcome independently.

Coding benchmark turns use the focused READ, WRITE, EDIT, and SHELL action profile.
Create task branches in the supplied workspace; external graders collect that
workspace’s commits and do not follow temporary worktrees.

For long coding runs, set `ELIZA_CODING_MAX_PROMPT_TOKENS` to a positive integer
to choose an explicit cumulative planner prompt-token budget. Unset runs retain
the default 1,500,000-token limit; cached prompt tokens count toward the budget.
The setting does not affect ordinary conversational turns or override an explicit
host-supplied planner budget. Record the value with benchmark results.

Interactive task events are committed atomically with each SQLite checkpoint.
The authenticated `GET /tasks/:id/events?after=-1` endpoint returns ordered pages
of up to 128 events, a cursor and `hasMore`; clients must follow all pages.
Older journals begin with an explicit `checkpoint` event rather than invented
history. `@elizaos/core/messaging/task-events` provides a browser-safe validator
and merge helper that reject gaps, conflicting replay and wrong-task data.
The feed contains lifecycle metadata, not page text, credentials or transcripts.

`services/sqlite-message-interaction-session-store` adapts the existing
message-interaction claim/commit/receipt protocol to a host-managed FULL/EXTRA
SQLite connection. Do not share an open transaction with store calls. Bind choices
to authenticated task context and revalidate at the effect boundary. Committed
unknown outcomes survive expiry cleanup until explicit reconciliation; a retry
must never execute them again. The host owns storage permissions and retention.

`services/interactive-task-choices` binds the shared interaction authority to a
runtime task and a trusted context hash. Identical offers reuse one durable
session; Pause/recovery/account epochs invalidate old callbacks. `respond` accepts
only an offered option, commits before invoking the host executor, and supplies a
stable operation ID plus a current-task guard. The executor must still verify
fresh observations and native authorization. Expired pending offers remain
expired; a new task epoch or changed trusted context requires a new review.

`services/interactive-task-presentation` exports `SqliteTaskPresentation` for a
single current host-issued choice per task. It stores presentation separately
from effect authority and rehydrates through `InteractiveTaskChoices` before
delivery. Reads never observe or execute the task. A newer publish/clear fences
older in-flight writes; expired or paused/old-epoch choices are not delivered.
Only trusted workflows may publish. Hosts bind chat routes to authenticated
account/task identity and dispatch responses through the existing choice authority;
model text and renderer metadata must never create offers or grant execution.

Hosts that hydrate credentials from an external protected store can set
`ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS` to up to 32 comma-separated environment
variable names before saving config. `saveElizaConfig` omits exact string values
currently held in those variables from its serialized copy without changing the
in-memory credential. Empty or absent variables contribute no value. Other
settings retain existing persistence behavior; invalid names reject the save.
This does not scrub old files, logs, transformed secret values or other stores;
the host still owns credential migration and custody.
