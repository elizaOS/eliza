# @elizaos/plugin-assistant

Explicitly registered conversational behavior for the Node runtime. Follow the
[root guide](../../AGENTS.md) and preserve the message and planner contracts
described below. Core does not register this plugin implicitly.

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
checks. See [the package README](README.md).

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

Before planned actions, pass complete original prior-dialogue events from the core source-selection result in action-local selectedActionConversation. Match the planner room/message binding to the executing request, overwrite stale projections, and preserve cached state. Selected, complete, fallback and restored contexts use the same identity-bound original source contract; applied reports omission and is not an authority gate. No raw provider prose, summary, context cap or extra model call supplies authorization.

Direct-conversation planning and READ_CONTEXT may publish a single model-authored acknowledgement through the optional onPlanningAcknowledgment callback. Reuse existing inference, recheck egress and cancellation, and publish native-read progress only after the requested sources are freshly authorized. Progress never persists an assistant message, marks an answer delivered, refreshes dialogue, or substitutes for final reply recovery. Ambient/decision-only reads retain their existing gates; canonical native tool arguments remain required.

Personal add_directive/remove_directive operations target only the requester; omission of scope cannot turn them into global changes. Removal requires the complete exact stored directive, preserving unrelated rules, traits and other slots. Exact removal resolves and mutates under the slot lock; absent rules produce no write or removal audit. Unknown legacy directive provenance remains unknown. Planner-owned directive changes return durable receipts and deferred reply grounding instead of a premature action callback.

History review checkpoints preserve original correction/dependency groups with the reviewed-prefix hash and scope binding. Foreground reads expand the complete connected originals through the same graph helper; literal match receipts still report only actual matches. Old checkpoints remain valid, malformed/stale groups fall back to full context, and current review completeness requirements remain unchanged.

Transient acknowledgements obey the normal owner-exclusive and outbound-envelope boundaries. Native context-read progress requires existing response admission and cannot trigger an extra adjudication; pending or blocked risk review withholds it. Final-response admission and recovery remain authoritative.

An early planning acknowledgement keeps the model's own wording; a rejected one is dropped, never substituted. It is spoken before any tool runs, so it must parse in a closed grammar where every word comes from a list. After lower-casing, straightening curly apostrophes and removing the final punctuation, the whole reply is one to three sentences, and each is a wait cue (on it, one/just a sec/second/moment) or progress. Progress is an optional wait cue and a comma, then a lead (let me, I'll, I will, I'm going to, give me a sec to, one sec while I) with a look-up verb or an intent, or an optional "I'm" with a look-up verb's gerund ("Checking…"), then up to two of now, for you, real quick, quickly. The reply may open with "Sure!" when the next sentence has a lead. The verbs are check (object optional in base form), look into and dig into, which take a container list or it, that, this or both; look at, look through and pull up, which take a container list; take/have a look, optionally "at" a container list; and search (object optional in base form). A gerund always has its object ("Checking both."), except "taking/having a look". A container list is "your" with calendar, schedule, agenda, notes, inbox, email(s), messages, texts, reminders, tasks, todos, files, photos, contacts, workflows, settings or account, or "the weather", joined by "and" or commas. Intents follow a lead and have no gerund: check with one capitalised word ("Let me check with Sarah."); check whether or if there are or you have any meetings, events, appointments, reminders, tasks, todos, notes, emails, messages or calls, optionally then today, tomorrow, this week or next week; open an app (calendar, notes, inbox, maps, files, photos, settings, workflows, camera, browser) or an item; read a container list or an item; save, create or update an item. An item is your, the or that with note, reminder, event, appointment, meeting, draft, task, email or message. Everything else answers a question in some context and is not listed: other assent (sure thing, okay, got it, no problem, absolutely, of course) answers yes or says it is fine; hang on/tight advises waiting; "let's" recommends; other write verbs (add, draft, schedule) and "it" after a write ("Adding it now." after "Is the dentist on my calendar?") say the item is missing; an intent's gerund or past form ("Opening now.", "I saved your note.") reports work under way or done; find, review, scan, go through, work on and handle read as an answer or someone's status ("Finding for you.", "Reviewing the files."); "double-check" says it was checked already; indefinite objects ("Pulling up an event") say an item exists; a date ("for tomorrow") says when it is; first and then rank. Any other word, name, emoji, dash, colon or bracket drops it: "Checking your flight on time", "Checking your calendar and nada" and "Let me check with Sarah, she said yes" are dropped. Digits, clock times, spelled counts, ordinals, quantity words, question marks, more than 120 characters, or a completed-effect or empty-state detector match also drop it. When Stage 1 plans a view with other work and the turn's registry evidence resolves its viewId to one view, a first sentence that is exactly that view's id or label ("Calendar. One sec.") is the destination the navigation policy asks the model to name and is not read as progress; the rest must still parse, the whole-reply checks still apply and the whole reply is spoken. A destination alone, another view or any other word is not skipped. The durable connector early reply keeps the bare progress whitelist. Activity status is separate and content-free: the optional onActivityStatus callback receives one label per started tool, in order, from the action's first labelled registered context, never its arguments or results. Unless every category the action lists is public and the action is ungated and nothing owner-exclusive was used, it is published only after the audience revalidates and the turn is still live; it adds no model call and never persists, replies or marks delivery.

For an internal nonterminal text result that requires a model reply, the evaluator native schema requires messageToUser in the same call; CONTINUE/context reads use an empty string. Visible, terminal and coding results retain their existing optional reply contract. Hosts without clipboard handling declare copyToClipboard:false so the evaluator cannot advertise or silently discard that effect. Standalone result consumers and actual callbacks remain supported.

Planner action callbacks retain genuine tool-owned interaction controls together with their explanatory text and media. Ordinary action prose waits for final publication even when a planner predicts its last batch. Verified action text remains exact at the final boundary without an unnecessary paraphrase call. Interactive controls are not restyled by the action-voice rewrite.

Native conversation-history decisions may use current_request as the source-set identity. Bind only that explicit reference from canonical HANDLE_RESPONSE arguments to the immutable sources captured for that model request. Core source validation still rejects stale/cross-room/unknown/incomplete selections. Legacy JSON and real mismatched hashes are not repaired implicitly; custom field schemas retain their declared contracts. Provider-owned raw model output is never mutated.

The shared direct-conversation, noncoding planner model facade may prefer provider-validated tool reasoning. It preserves the planner thinking policy and cache options; the provider must explicitly support the preference. Handler/evaluator calls, group/unknown channels and coding turns receive no preference. This adds no model call or prompt text.


Direct-conversation native Stage 1 may compose replies from text and authorized complete
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


Authorized providers may expose complete original records through the shared
original-message renderer. Carry source metadata into context only when it
exactly reconstructs the supplied text (apart from its existing outer trim),
and revalidate after discovery projection. Provider-only quotations bind to the
current provider fingerprint independently of current-room history selection.
Keep provider IDs out of history selectors and persisted same-room quote links;
redaction, withheld sources, missing identity or duplicate IDs never authorize
raw metadata reads. Full delivery-audience checks remain mandatory.


An authenticated same-room interrupted assistant receipt remains terminal state
when no text was delivered. Carry its status beside the uniquely linked original
request, without rewriting either dialogue body or treating interruption as a
rollback of committed effects/background tasks. A casual approval cannot reuse
an interrupted preview; an explicit new continuation request remains available.


When supplied original sources enable native source replies, advertise an ordered
reply-parts array rather than an equal legacy string alternative. Ordinary prose
uses text parts; original source parts render as separate blocks without changing
literal bytes. Legacy string responses remain accepted, and JSON-envelope parts
still require an actual source identity (never an implicit native request alias).


Personal interaction rules are available through the existing memory context,
with PERSONALITY owning their state and exact directive edits; MEMORY owns
factual records. Declaration and validation share the same context set. A
planner-owned personality state read stays internal until the whole request has
been resolved; standalone state inspection keeps its existing presentation.
Last-resort reply rescue uses the complete current context and canonical tool
messages, including archived results, rather than disconnected success excerpts.
Composed failure instructions remain scrubbed; original authorized diagnostic
records stay separate evidence, and existing final-output checks still apply.


Stage1's existing single routing repair also reviews contradictory structured
navigation declarations (VIEWS_SHOW with no navigation, or navigation-only with
multiple/unknown views). It never converts forbidden navigation into permission,
infers an action from wording, or adds an unbounded retry. Normal plugin admission
and navigation receipts remain authoritative after the review.

Text and completed voice transcripts share response admission, native schemas, history/source reads, provider selection, action discovery, planning and completion. Only audio ingress/playback and interruption transport differ. Stage 1 receives exact room dialogue and essential interpretation state; action catalogs and domain evidence belong to planning or explicit authorized reads. Display routing contexts only when backed by available actions/providers, using authored short descriptions without internal registry metadata.
