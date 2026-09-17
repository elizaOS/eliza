# Recovery and compatibility disposition

This review supplements [runtime flows](FLOWS.md) and [acceptance status](STATUS.md).
It distinguishes deleted policy from necessary execution boundaries and remaining
work. It does not certify the final combined change or hosted checks.

## Deleted paths

| Path | Replacement or reason for deletion | Behavioral evidence |
| --- | --- | --- |
| Structured executor retries a thrown `useModel` dispatch | No replacement loop. Provider dispatch owns transport recovery; a thrown dispatch becomes `model_error`. Schema-invalid returned output can still receive semantic repair. | Structured retry integration covers exhausted transport/credentials, provider fallback, invalid output and callback draining. |
| Planner retries HTTP failures matching “failed to generate tool_call” | No replacement. Error text cannot reset the provider dispatch budget. | `planner-loop-post-tool-evaluator-failure.test.ts` offers a successful second response and proves it is never requested; no tool or evaluator runs. |
| `PLAN_ACTIONS` unwrap redirects to a nested action name | No replacement. Native calls retain their tool name and arguments. Current local guided decoding emits a bare action record, not this wrapper. | `planner-loop-tools-vs-schema.test.ts` preserves native identity and nested arguments. Existing bare-action planner tests remain. |
| Local-inference `planner-skeleton.ts` facade | Deleted three functions, two exported types and their dedicated wrapper tests. Repository callers were only the facade's barrel and tests; production calls existing grammar builders. | Core response-grammar tests retain registered-name and parameter constraints. Local tests retain compiler number/boolean behavior and sampler wire encoding. |
| Executor argument envelope guessing | Core validates the selected action's declared parameter object; assistant supplies `params`. | `execute-planned-tool-call.test.ts` retains malformed input and effect contracts. Removing provider protocol conversion is a separate task below. |

## Retained boundaries

| Boundary and owner | Why it remains | Constraint on simplification |
| --- | --- | --- |
| Provider fallback, `packages/core/src/runtime/model-dispatch/dispatcher.ts` | Registered providers can be unavailable or fail transiently. A pinned provider, cancellation, partial output and exhausted provider budget change whether another registration is eligible. | Keep one dispatch authority. Do not retry the same exhausted provider through another registration or replay an emitted stream. Provider protocol retry remains provider-owned. |
| Structured output repair, assistant `runtime/structured-prompt/executor.ts` | A completed response can violate its requested schema even though transport succeeded. | Repair invalid returned output with complete context; never convert a transport exception into a new semantic attempt. Drain owned delivery before settlement. |
| Planner unavailable-tool/scope correction, assistant `runtime/planner-loop.ts` | A model can name unavailable tools or provide contradictory continuation scope. Those responses must not execute effects. | Keep correction bounded and distinct from transport retry. Do not broaden available actions or infer authorization from model prose. |
| Context restoration and overflow, assistant planner | Selected source references may need complete originals; a provider can reject a complete request. | Restoration reads original authorized data. Never truncate to make a retry pass, replay an effect, or report an overflow as successful completion. |
| Effect settlement, core `runtime/action-handler-settlement.ts` and `runtime/effect-delivery.ts` | A committed write and a failed reply are different outcomes. | Keep receipts and delivery outcome separate; reply recovery must not execute the write again. |
| Terminal lifetime, core `runtime/run-terminal-owner.ts` and assistant `services/message/turn-lifetime.ts` | Cancellation, asynchronous callbacks and shutdown can race with work. | One terminal settlement closes owned work and rejects late effects/delivery. A helper split is not proof of fewer lifetime states. |
| Fresh authority before effects/disclosure | Stored roles and audience access can change while model or tool work awaits. | Keep checks at the actual boundary. Fixtures must establish canonical stored authority rather than bypass this check with a supplied role. |
| Shared provider waiter accounting, core `runtime/state-composition/provider-execution.ts` | Two consumers can share work; cancellation of one must not cancel the other's request. | Preserve last-waiter cancellation and scope isolation. This is concurrency behavior, not an obsolete platform fallback. |

Relevant retained suites include `use-model-provider-fallback`,
`model-provider-failover`, `planner-loop-context-overflow`,
`planner-loop-pending-scope`, `planner-loop-effect-freshness`,
`planner-loop-internal-effect-reply-failure`, `compose-state-provider-execution`,
`message.run-terminal-owner`, `message.preserved-tool-result` and
`message.transcript-visibility`. Passing one suite does not establish all of these
boundaries or replace the issue's real database/provider acceptance matrix.

## Still incomplete: one provider result representation

`ToolCall` in core still exposes alternate argument/name fields. Assistant
`normalizeToolCall` consumes both provider results and calls recovered from model
text. OpenAI and Anthropic native result interfaces still permit `unknown[]`;
OpenAI passes AI SDK `toolName`/`input` records through its result builder. Local
guided generation and CLI inference also produce bare `action`/`parameters`
records. These are live producers, not evidence that every alias is necessary.

Finish this migration by typing provider results at each adapter's output,
converting native protocol names/arguments there, and updating streaming and
non-streaming consumers together. Keep model-authored text interpretation in the
assistant's explicit parse boundary. Then remove unsupported aliases from core
and assistant with provider-wire, complete-argument, malformed-input, streaming,
and effect-identity tests. Do not restore the deleted `PLAN_ACTIONS` redirect to
make an obsolete fixture pass.

The planner's many reply/scope branches and host request dispatch still require
review. Measure core together with assistant, prompts, shared, credentials,
storage and affected provider owners. Moving parsing or policy between them is
not a whole-workflow complexity reduction. Linguistic algorithms and test-server
stubs must not be treated as equivalent to runtime orchestration hotspots.
