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
The pause route accepts optional `reason: "close"` when the user closes the task
surface. This keeps the pause transition but passes `close` to `quiesce`; ordinary
Pause, cancel, and revoke pass their own reasons. Per-task cleanup runs in control
order, and a retry retains its reason.

Trusted hosts may call `runtime.reconcile` for an unknown operation through an
optional actuator `reconcile` readback implementation. It must read evidence only,
never repeat the effect. Revision/epoch and account checks fence late results;
resolved results require a durable evidence reference. Reconciliation does not
resume the task. This method is deliberately absent from renderer HTTP routes.

## Optional phone workflows

Lean-chat hosts may set `ELIZA_LEAN_CHAT_WORKFLOWS=1` to retain the workflow
plugin while keeping the lean profile's desktop actuator exclusions. Android
hosts may independently set `ELIZA_MOBILE_WORKFLOWS=1`; the default remains
workflow-free, and iOS remains excluded. An explicit `workflow.enabled: false`
or disabled `plugins.entries.workflow` overrides either opt-in.

Android bundles include the optional workflow plugin, but execution still
requires the separately verified workflow worker/compiler resource directory
and the process-host configuration. Enabling the plugin does not establish
worker readiness or authorize device effects. Use the existing reviewed
workflow and device-action permission/receipt boundaries.

Native Notes read completion is opt-in. Trusted hosts must supply
`ELIZA_HOST_CONTEXT_REVISION` and rotate it when the account or provider authority
changes. Without it, approvals retain ordinary typed receipts but cannot start a
model continuation. After Share, the authenticated owner explicitly calls
`POST /api/client-devices/proposals/:id/read-completion` with the retained original
request correlation and receipt attempt. The reply uses only the shared snapshot
and is saved in the original room; receipt reads do not start inference. The
matching `cancel-read-completion` route retires the completion. Deploy the additive
`0006_device_read_completion` migration without resetting existing approvals.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/agent build  # build
bun run --cwd packages/agent test   # tests
```

Retain real end-to-end scenarios exercising host, transport, and persistence.
The package test, test:e2e, and test:integration commands share that suite;
do not reintroduce removed unit, mock, smoke, or source-inspection tests.

Remote push (APNs/FCM) acceptance requires an enrolled device, token registration
through the authenticated API, and confirmed delivery to that device while the
app is backgrounded or closed. The local agent suite does not verify device delivery.

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
history. `@elizaos/core/protocol` exports a browser-safe validator and merge
helper (`validateTaskEvent`, `mergeTaskEvents`) that reject gaps, conflicting
replay and wrong-task data.
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

Each explicit uncertain-operation readback commits a recovery epoch before binding
the actuator. An ambiguous result or lost reply therefore cannot strand the next
readback on a native epoch that was already consumed. The original operation stays
unknown until evidence resolves it, and recovery never resumes or repeats effects.

Mobile hosts may set `ELIZA_MOBILE_DNS_SERVERS` to one through eight comma-separated
IP literals from their trusted native network configuration. Missing configuration
retains the public resolver defaults; malformed addresses reject before installing
DNS overrides. This startup snapshot does not implement Private DNS, VPN-bound
resolution or automatic network-change refresh.

## Native host composition

Hosts with their own native view renderers may set
`ELIZA_NATIVE_VIEW_DECLARATIONS` before runtime startup. Its value is a JSON
array of at most 32 navigation-only declarations with `id`, `label`, `path`,
and optional `fallbackFor` (an exact plugin package name). For example:

```json
[{"id":"native-gallery","label":"Gallery","path":"/native-gallery"}]
```

This is trusted host configuration, never renderer metadata or a device view
profile. Entries use existing runtime installations, have an OWNER role gate,
declare no capabilities or controls, and retain `available: false` because they
supply no hosted executable. Registered completed-action clients still require
the normal owner/client/installation preparation, claim and acknowledgment.
Ordinary originating-client delivery cannot use an unavailable hosted view.
An exact preview builtin may have a host-selected released native counterpart;
system/release builtins cannot be overridden. Already installed plugin entries
remain authoritative. Later plugin replacement requires an explicit matching
`fallbackFor`, route and modality. Without this setting, catalogs are unchanged.

`native-host/gateway.mjs` is a dependency-free Node source entrypoint for native
hosts shipping a separately verified gateway payload. Supply an explicit
`hostPolicy`: origins, resetPaths, conversationTitle, abortReason, validateTitle,
prepareMessage, isPaidAction, formatTaskContext, and optional messages. The policy
owns product language and view metadata; the gateway owns authenticated loopback
transport, bounded JSON, conversation ownership, request cancellation, account
fencing and authenticated task presentation. Only trusted host code provides this
policy; never accept it from renderer input.

`native-host/account-state.mjs` preserves private credential-derived namespaces
and configuration migration. `native-host/runtime-supervisor.mjs` serializes
identity transitions and stops only the child returned by the host launcher.
These are source entrypoints for explicit payload composition, not additional
browser SDK or published dist exports. Production consumers must preserve their
own registration, origin policy, encrypted storage and lifecycle adapters.

The native-host end-to-end test uses real local HTTP, disk restart and child
processes. Run `node --test packages/agent/native-host/gateway.e2e.test.mjs` from
the repository root; it is also included by the package's Vitest suite.

`native-host/private-runtime-launch.mjs` composes host-only literal settings,
allowlisted inherited environment, persistent private tokens and a separate
generated launch config. The trusted host supplies paths, default configuration,
provider policy, command and launch-receipt callback. It owns one child and reaps
it if receipt persistence fails; signal listeners are removed on child closure.
It does not restart processes or replace the account supervisor. Parent
directories must be private and host-controlled, and receipt callbacks must
settle. Hosts with an existing token-format contract may supply a synchronous
`createToken` factory; it runs only for a newly created token file. Existing
tokens are preserved and validated regardless of the current factory. The native-host end-to-end suite covers real disk and child-process
isolation, failure cleanup and cancellation during launch.

`native-host/task-evidence-store.mjs` stores host-validated append-only evidence
separately from the task transition journal. Supply a trusted table name, source,
input validator, record limit and authenticated owner. The task reader must use
the same synchronous SQLite connection without starting its own transaction.
The store serializes ownership/epoch checks, sequencing and idempotency with
writes; it never advances tasks or authorizes effects. Keep product measurement
schemas and summaries in the host. Existing compatible tables are preserved.

Trusted native hosts can use `native-host/private-runtime-launch.mjs`'s
`readPrivateRuntimeJson` for bounded, read-only POSIX configuration reads. Hosts
supply the byte budget and own parent-directory trust and schema validation.
The reader rejects symlink leaves, non-regular files, unexpected ownership and
group/other permissions; it never creates files or changes their permissions.

Hosts whose runtime writes its own persistent configuration should use
`preparePrivateRuntimeProfile` and continue passing their original config path
to that runtime. It returns the saved token and parsed configuration without
rewriting existing bytes. `preparePrivateRuntimeFiles` composes this primitive
with a separate generated launch config for hosts that need a per-launch selection.

`SqliteInteractiveTaskStore.readOwnerHistory` supplies complete owner-scoped
histories within explicit task/event limits to a synchronous, read-only host
projection. It reuses page validation and rejects revision, cross-connection,
same-connection or schema changes instead of publishing a partial report. It
adds no effect authority and must not be called inside an existing transaction.
