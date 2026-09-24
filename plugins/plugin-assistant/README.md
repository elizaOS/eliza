# @elizaos/plugin-assistant

Conversation policy and default agent behavior, explicitly registered with
`AgentRuntime` through `createAssistantPlugin()`. The package owns message
processing, prompts, planning, evaluation and default feature contributions.
Core owns the executor and lifecycle; SQL and model providers remain separate.

Use one explicit host composition rather than minimal/full runtime presets.
Omit this plugin when supplying another message processor. Domain-specific
capabilities can be supplied by additional plugins.

Tests use strict deterministic model fixtures or loopback protocol providers;
real provider tests are opt-in. Package scripts provide `build`, `typecheck`,
`test` and `lint:check`. See [runtime flows](../../docs/design/runtime-consolidation/FLOWS.md)
and [migration status](../../docs/design/runtime-consolidation/STATUS.md).

Optional JSON-file trajectory recording and cost annotation are owned here.
Core retains the recorder interface and shared value/redaction operations; it
does not write trajectory files or contain a provider price/context catalog.
Provider context limits use `ModelRegistrationMetadata.contextWindowTokens`.
Explicit input reserves are honored even when equal to the default; unknown
model names never select a guessed provider limit. The legacy budget fallback
is diagnostic only and never truncates or rejects a complete request.

Structured-prompt retries repair invalid model output only. Provider dispatch
owns transport failures and fallback; exhausted dispatch records a model failure
without restarting the provider chain. The planner follows the same boundary,
including required-tool generation errors. Cancellation remains terminal.

Action catalogs and search-keyword selection are owned here. Matching uses the
canonical prompts keyword module; core supplies only localization contracts.
Retrieval uses one default ranking policy; process-wide MODEL_TIER presets no
longer change its weights. Callers can supply explicit retrieval weights.

Conversational entity resolution and entity prompt formatting are owned here.
Core enforces component visibility using resolved roles and preserves stable
agent-scoped IDs. Template rendering is imported from prompts.

See the [recovery disposition](../../docs/design/runtime-consolidation/RECOVERY.md)
for deleted retry/compatibility paths, consolidated miss handling, retained
boundaries and the remaining workflow review.

Signed prompt artifacts, activation/rollback and the fixed optimization task catalog
are owned by `src/services/optimized-prompt.ts`. Import artifact types and
`OptimizedPromptService` from this package. Core only resolves complete text
through the optional `RuntimePromptResolver` contract; it owns no artifact files
or domain task names. Persisted files, MACs and activation links are unchanged.

The documents feature owns the shared access policy and bounded service loader
used by host knowledge actions and document HTTP routes. Their document scope,
source and role types come from the same feature contracts.

Action parameter extraction and grounded action replies are assistant policy.
Import them from this package; they preserve complete conversation and action
results, including planner-owned deferred reply receipts.

Cache-backed pause windows, room handoff state and pending owner prompts are
assistant services. Hosts may register them explicitly; the exported store
resolvers use the same runtime cache when a service is absent. Service names,
cache keys and pending-action projections remain stable.

The approval queue, dispatch control and optional ApprovalService are owned here.
Hosts register ApprovalService explicitly. SQL owns the existing approval tables;
HTTP routes and caller authentication remain in the agent host. Import approval
contracts from this package without loading agent process code.

Hosts may enable `ELIZA_STAGE1_TERMINAL_REASK` with `true`, `1`, `yes`, or `on`
to review a directly addressed STOP or IGNORE decision once before terminal
routing. It is off by default and excludes coding turns. The review
shares its budget with the shared direct-conversation IGNORE review, so a repeated
terminal decision does not start another silence review. Requested context is
loaded before review; malformed output and conflicting routing retain their
existing validation paths.

## File trajectory retention

The assistant registers an agent-scoped repeating task on core TaskService,
using the host's normal task storage adapter, to remove completed JSON file
trajectories older than 14 days. Set `ELIZA_TRAJECTORY_RETENTION_DAYS=0` to
disable cleanup, or use a nonnegative integer day count. Invalid settings fail
service setup. The task checks every six hours while the host runs its normal
task clock; serverless hosts must drive due tasks as usual.

The file-retention service is independent of optional SQL trajectory capture.
Cleanup retains running records, temporary writes, unrelated files and records
belonging to another agent. It does not prune SQL trajectories or Markdown
review artifacts. Filesystem failures remain visible through normal task error
handling. Shutdown unregisters the worker and waits for accepted cleanup.
