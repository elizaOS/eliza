# @elizaos/plugin-assistant

Explicitly registered conversational behavior for the Node runtime. Follow the
[root guide](../../CLAUDE.md) and preserve the message/planner invariants recorded
in the [core guide](../../packages/core/CLAUDE.md). Those invariants moved with
this implementation; core does not register this plugin implicitly.

`createAssistantPlugin()` composes contributions. `src/services/message.ts` and
`src/services/message/` own message processing and reply policy;
`src/runtime/` owns the planner/evaluator loop; `src/features/` owns default
feature contributions. The kernel retains executor authorization, provider-state
isolation, model dispatch and terminal ownership. Do not reimplement those
boundaries in a feature.

A handler returns an explicit `ActionResult` with boolean `success`. Planner
calls use `{ name, params }`; do not rely on legacy argument guessing. Preserve
effect receipts and separate delivery failures from committed work. Cancellation
must not trigger replay to regenerate prose. Models and storage are supplied by
separate registered plugins; deterministic tests use strict private fixtures.

Run `bun run --cwd plugins/plugin-assistant typecheck`, `test`, `lint:check`
and `build`. Keep source-only tests distinct from packed native Node import
checks. See [runtime flows](../../docs/design/runtime-consolidation/FLOWS.md)
and [implementation status](../../docs/design/runtime-consolidation/STATUS.md).

## Verification receipts

SHELL owns command and test-output interpretation in the coding-tools plugin.
Foreground results may include typed `ActionResult.verification` with kind,
status, family, and exit code. Assistant policy consumes that receipt rather
than interpreting command syntax or reassuring prose. Workspace delta receipts
continue to bind verification to the execution domain and unchanged files;
background polls, help commands, and empty test selections do not prove an edit.
