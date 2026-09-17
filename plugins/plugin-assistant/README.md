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
