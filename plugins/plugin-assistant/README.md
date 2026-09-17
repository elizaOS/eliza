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

Conversational entity resolution and entity prompt formatting are owned here.
Core enforces component visibility using resolved roles and preserves stable
agent-scoped IDs. Template rendering is imported from prompts.

See the [recovery disposition](../../docs/design/runtime-consolidation/RECOVERY.md)
for deleted retry/compatibility paths, consolidated miss handling, retained
boundaries and the remaining workflow review.
