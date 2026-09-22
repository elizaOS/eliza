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

Optional feature contributions are selected by host plugin composition. There
are no native-feature default/service-resolution tables or document core/headless
presets. Use createDocumentsPlugin with explicit contribution options when a
host needs retrieval without the DOCUMENT action. Document parsing is Node-only.

Assistant initialization owns the prompt batcher and BATCHER_DRAIN task worker.
The generic kernel and TaskService do not create them. Autonomy uses the
assistant-owned batcher; unloading assistant disposes it and unregisters its
worker. Batcher configuration is validated when assistant is composed.

The assistant reasoning lifecycle installs structured prompt execution together
with batching and removes both on unload. runtime/structured-prompt owns template
rendering, response schemas, semantic recovery and streaming interpretation.

Before each planned action, pass validated dialogue selection as complete source events in an action-local selectedActionConversation value. Reuse core source-set validation; never replace cached provider history or carry a stale previous selection into a fallback. Null retains the domain's full-history fallback, while an explicitly reviewed empty selection serializes as []. This projection adds no model call and changes no action admission or receipt authority.

Direct-text planning and READ_CONTEXT may publish a single model-authored acknowledgement through the optional onPlanningAcknowledgment callback. Reuse existing inference, recheck egress and cancellation, and publish native-read progress only after the requested sources are freshly authorized. Progress never persists an assistant message, marks an answer delivered, refreshes dialogue, or substitutes for final reply recovery. Voice/ambient/decision-only reads retain their existing gates; canonical native tool arguments remain required.

Personal add_directive/remove_directive operations target only the requester; omission of scope cannot turn them into global changes. Removal requires the complete exact stored directive, preserving unrelated rules, traits and other slots. Exact removal resolves and mutates under the slot lock; absent rules produce no write or removal audit. Unknown legacy directive provenance remains unknown. Planner-owned directive changes return durable receipts and deferred reply grounding instead of a premature action callback.

History review checkpoints preserve original correction/dependency groups with the reviewed-prefix hash and scope binding. Foreground reads expand the complete connected originals through the same graph helper; literal match receipts still report only actual matches. Old checkpoints remain valid, malformed/stale groups fall back to full context, and current review completeness requirements remain unchanged.

Transient acknowledgements obey the normal owner-exclusive and outbound-envelope boundaries. Native context-read progress requires existing response admission and cannot trigger an extra adjudication; pending or blocked risk review withholds it. Final-response admission and recovery remain authoritative.

For an internal nonterminal text result that requires a model reply, the evaluator native schema requires messageToUser in the same call; CONTINUE/context reads use an empty string. Visible, terminal and coding results retain their existing optional reply contract. Hosts without clipboard handling declare copyToClipboard:false so the evaluator cannot advertise or silently discard that effect. Standalone result consumers and actual callbacks remain supported.

Planner action callbacks retain genuine tool-owned interaction controls together with their explanatory text and media. Ordinary action prose waits for final publication even when a planner predicts its last batch. Verified action text remains exact at the final boundary without an unnecessary paraphrase call. Interactive controls are not restyled by the action-voice rewrite.

Native text-history decisions may use current_request as the source-set identity. Bind only that explicit reference from canonical HANDLE_RESPONSE arguments to the immutable sources captured for that model request. Core source validation still rejects stale/cross-room/unknown/incomplete selections. Legacy JSON and real mismatched hashes are not repaired implicitly; custom field schemas and voice retain their established paths. Provider-owned raw model output is never mutated.

The existing direct-text, noncoding planner model facade may prefer provider-validated tool reasoning. It preserves the planner thinking policy and cache options; the provider must explicitly support the preference. Handler/evaluator calls, voice, group/unknown channels and coding turns receive no preference. This adds no model call or prompt text.


Direct-text native Stage 1 may compose replies from text and authorized complete
same-room original-message parts. Bind source IDs and exact bytes to the current
turn's supplied context; reject unresolved or duplicate source decisions before
field effects. Keep raw model output in recordings. Render literals only after
field/evaluator reply overrides have been honored. Runtime-only bindings protect
literal bytes through cosmetic cleanup; serialized references are read hints,
never sanitizer authority. Full audience and security-envelope checks still run.
Only one complete source with whitespace-only framing is exempt from new-claim
inference; mixed prose or multiple sources use the complete rendered claim checks.
Persisted quote links may reload unchanged earlier originals through the existing
authorized history path, with no recency floor, summary or extra foreground model.
