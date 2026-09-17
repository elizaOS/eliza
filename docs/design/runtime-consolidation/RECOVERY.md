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
| Companion URL task/embedding transport | Deleted the unused constructor option, runtime property, embedding HTTP branch and task notification method. No tracked host supplied this option. Task mutations wake the local task service; embedding work uses the existing registered event handlers. Hosts needing remote execution must own that transport. | Task dirty-wakeup/scheduler, embedding lifecycle and dimension suites; packed kernel asserts no companion property. |
| Unused server-health polling utilities | Deleted `waitForServerReady`, `pingServer`, options/error types and the implementation. No tracked production caller existed; only barrels and dedicated tests referenced them. | Removed the retired helper tests and export-shape assertion; retained local-URL behavior tests. Packed kernel checks that the old functions are absent. |
| Executor argument envelope guessing | Core validates the selected action's declared parameter object; assistant supplies `params`. | `execute-planned-tool-call.test.ts` retains malformed input and effect contracts. Removing provider protocol conversion is a separate task below. |

## Consolidated policy

Required-tool misses from a text-only response and terminal-only tool calls now
share one settlement policy in `runPlannerLoopIterations`: repeated widget/answer
detection, capture precedence, budget exhaustion and corrective feedback. Each
input form still selects its own safe answer source before settlement; native
scratch text is not a reply. This removes 62 net implementation lines rather
than moving two copies behind separate wrappers. Planner regression suites cover
both forms, inferred versus explicit tool requirements, refusal/widget recovery
and exclusion of native scratch text.

Ordinary evaluator completion and post-tool reply evaluation now reuse the
existing `finishWithEvaluator` settlement path. Two duplicate copies of failure
authority, reply selection and safe delivery were removed (42 net implementation
lines). Pending-scope correction and bounded silent-failure recovery still happen
before settlement; the evaluator's safe failure diagnosis retains precedence.

The concrete keyless Parallel/Exa web-search client and its tests now belong to
`plugin-web-search/keyless-web-search`. Host actions, coding tools and the cloud
fixture consume that owner; core no longer exports the client or embeds its
provider endpoints. This is a 320-line implementation/test relocation, not a
whole-repository deletion. Fixed endpoints, redirect refusal, timeout and byte
limits, complete response handling and provider fallback remain unchanged.

Capability-router protocol fixture data and its version marker now live in the
private testing package. Their only consumers are conformance tests and a local
fixture server. Core retains the protocol interfaces, broker implementation and
behavioral tests, with no production import of testing. This removes 250 lines
of test payloads from the runtime source, while preserving them for tests.

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

## Model dispatch review

`runtime/model-dispatch/dispatcher.ts` now uses Node's monotonic performance
clock directly at all five timing sites. The unsupported-platform clock probes
and wall-clock fallback branches are deleted; no replacement clock helper or
runtime mode is introduced.

The two stream consumption paths have different ownership: callback delivery is
awaited inside `useModel`, while a returned stream is pulled by the caller after
`useModel` returns. Both must re-enter the model-call recording scope for iterator
advancement and cleanup, but only the returned stream needs deferred recording
and an unconsumed-text backstop. Merging them by eagerly consuming the returned
stream would change cancellation, backpressure and delivery. Retain these two
lifetimes; deduplicate final recording through the existing trajectory recorder.

Preparation rejection is distinct from dispatched provider failure. A rejected
context-window admission incurred no provider call; a dispatched attempt may
have incurred cost or emitted output. Retain that distinction, the per-provider
exhausted-budget set, strict provider pins and the no-fallback-after-output gate.
These prevent replay and preserve the actionable failure when an unavailable
local fallback cannot serve the request. They are not browser compatibility or
model-text recovery. The provider-failover, streaming, guarded-stream, swap,
action-routing and trajectory-deduplication suites cover these boundaries.

## Provider result contract and remaining text recovery

Core `ToolCall` exposes `id`, `name`, and `arguments`, plus diagnostic result/status
fields. Alternate argument/name aliases have been removed. Stage-1 response and
context-read parsing and trajectory extraction consume the canonical fields.
OpenAI and Anthropic convert SDK output at their provider boundaries and reject
SDK-invalid calls while preserving their validation cause. Google and Eliza Cloud
return the same canonical fields; Codex, ZeroLlama and Capacitor native adapters
already supply them. Streaming and buffered results share this contract.

Assistant native consumption now preserves the provider's identity and accepts only
object arguments or a complete JSON object string. It does not strip name prefixes,
recover malformed JSON, or guess SDK field aliases. Model-authored text enters
`parseTextToolCall` separately; SDK-only name/input fallbacks have been removed
there too. Local guided generation and text-oriented CLI inference still use
supported text envelopes such as `action`/`parameters` and `type`/`args`.
These text parsers remain explicit assistant policy, with their parser and effect
coverage. Provider wire and streaming conversion remain provider-owned.

The planner reply/scope source review is complete. Pending scope requires explicit
final release; unchanged evaluated evidence may reuse FINISH without replaying
effects. Replacing a reply requires evaluation, while filling a missing reply
requires effect receipts. Reply-only continuation cannot dispatch new effects,
and native scratch text cannot become a delivered reply. These are distinct
contracts, retained after consolidating required-tool miss and evaluator finish
policy. Existing pending-scope, effect-freshness and reply-failure suites own
acceptance; combined qualification and current measurements remain required.

Measure core together with assistant, prompts, shared, credentials,
storage and affected provider owners. Moving parsing or policy between them is
not a whole-workflow complexity reduction. Linguistic algorithms and test-server
stubs must not be treated as equivalent to runtime orchestration hotspots.

## Host request routing disposition

The host keeps its ordered request pipeline. Host/CORS admission, runtime-mode
visibility, API authentication, owner-only mutations and remote forwarding have
different ordering contracts. Mobile guards avoid importing unavailable plugins;
curated skills and directory plugin loading precede generic routes. Backup
streaming, runtime replacement and plugin transport adapters retain their distinct
failure and lifetime semantics. A generic middleware rewrite would relocate these
policies without removing them.

The review removed four unreachable private helpers, their exclusive setup and
33 import-to-constant aliases from `packages/agent/src/api/server.ts`: 100 net
lines, with public reexports and active routing unchanged. Existing host auth,
cookie/CORS, lazy routing, route dispatch, state and provider-switch suites own
these boundaries; final combined package acceptance remains required.
