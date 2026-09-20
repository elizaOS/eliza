# Remote file decisions

Reviewed source: `d0d478fe7dd` against shared merge `89a476f3d75`.
Candidate-specific dispositions; a hold is unresolved integration work, not acceptance.
All127 changed paths were inspected. Test decisions do not claim tests were run.

| Path | Decision and evidence |
| --- | --- |
| `packages/agent/src/actions/memories.test.ts` | Keep explicit pagination; exclude new create-hint expectation because it changes failed-update intent into presumed creation. |
| `packages/agent/src/actions/memories.ts` | Exclude auto-pagination and missing-update create hint. No existing target is not evidence of authorization to create a new record; typed mutations already require explicit target. Preserve failed-update distinction. |
| `packages/agent/src/api/chat-routes.ts` | Remote delta is comment expansion only; no implementation to integrate. |
| `packages/agent/src/api/conversation-routes.ts` | Remote delta is comment expansion only; no implementation to integrate. |
| `packages/agent/src/config/schema.ts` | Defer keyed-search settings retirement to a config migration change. Retain current compatibility fields; removing exposed settings is not required for the selected text flows. |
| `packages/agent/src/config/schema.web-search-hints.test.ts` | Defer with keyed-search settings migration; this test alone does not establish compatibility for existing configuration. |
| `packages/agent/src/config/zod-schema.agent-runtime.ts` | Defer comment change with excluded search-settings migration. |
| `packages/agent/src/runtime/prompt-optimization.test.ts` | Keep missing/zero/requested/provider temperature distinction tests removed remotely. |
| `packages/agent/src/runtime/prompt-optimization.ts` | Keep missing-vs-zero temperature telemetry; remote fabricates zero and overwrites explicit zero. |
| `packages/app-core/scripts/dev-ui.mjs` | Keep force-flag-free local voice probing; voice acceptance remains excluded. |
| `packages/core/AGENTS.md` | Keep named description schemas, full alias reconstruction and exact history-read/source-repair contracts removed remotely. Remote guide pair verified byte-identical. |
| `packages/core/CLAUDE.md` | Keep named description schemas, full alias reconstruction and exact history-read/source-repair contracts removed remotely. Remote guide pair verified byte-identical. |
| `packages/core/README.md` | Keep documentation for dedicated post-turn instructions, native schema fallback, exact named-tool schemas and history/source repair. Remote removes these and describes held inline catalog projection. |
| `packages/core/src/__tests__/action-discovery-timing.test.ts` | Exact proposed own-context discovery/contextless state-identity test already exists at current lines198-270. Focused suite passed; no duplicate import. |
| `packages/core/src/__tests__/entities-format.test.ts` | Do not import tests requiring removal of image fields and normalized identity aliases; complete metadata contract remains. |
| `packages/core/src/__tests__/media-reply-sanitize.test.ts` | Keep removed regressions separating fetched source URLs from delivered media and preserving source citations. |
| `packages/core/src/__tests__/message-answer-clobber-rescue.test.ts` | Keep removed real message-flow source citation regression after WEB_FETCH. |
| `packages/core/src/__tests__/message-failure-reply.test.ts` | Keep no-extra-call credit/auth failures and domain/provider authorization distinction; remote relaxes call count and deletes cases. |
| `packages/core/src/__tests__/message-runtime-stage1.test.ts` | Keep native read/ready separation, bounded malformed-source repair, one-decision options and complete custom aliases. New discovery assertions require coverage comparison; do not import broad test rewrite. |
| `packages/core/src/__tests__/message-stable-prefix.test.ts` | Fixture-only optional actions/getRoom/reportError; no new assertion or missing behavior. |
| `packages/core/src/__tests__/message-stage1-action-catalog.test.ts` | Do not import pure formatting tests for held lossy inline catalog projection. |
| `packages/core/src/__tests__/message-stage1-context-catalog.test.ts` | Current renderer retains aliases, parent/parents and sensitivity and filters role/cache metadata; existing suite passes role-filtered full-description contract. No production delta; do not add renderer-mirroring assertions solely for parity. |
| `packages/core/src/__tests__/tiered-action-surface.test.ts` | Keep removed channel/discovery/alias/complete-description tests; remote expects omitted children/aliases. Additional index-only assertions tied to remote projection, not new domain behavior. |
| `packages/core/src/entities.ts` | Reject arbitrary metadata/key omission and name normalization; preserve complete identity/provenance context. |
| `packages/core/src/features/advanced-capabilities/actions/message.ts` | Already integrated in current candidate: selectConnectorForOp uses soleConnectorFamily. Eight connector-selection tests passed, including distinct accounts/sources and duplicate routes staying ambiguous. No re-import needed. |
| `packages/core/src/features/advanced-capabilities/evaluators/reflection-items.ts` | Reject shared action-result cap; complete result context required. |
| `packages/core/src/features/advanced-capabilities/experience/utils/experienceFormatter.test.ts` | Superseded by current experienceProvider.test.ts exact-byte/provenance tests at128-176, preserving full learning/result/rationale and original records. Provider suite passed; no label-specific helper duplicate. |
| `packages/core/src/features/advanced-capabilities/experience/utils/experienceFormatter.ts` | Keep current byte-exact local reference; remote mainly rearranges WHY/RATIONALE. No required missing behavior established. |
| `packages/core/src/features/trajectories/TrajectoriesService.ts` | Exclude automatic14-day deletion from this candidate. This changes evidence retention policy and does not repair a demonstrated text-flow defect. |
| `packages/core/src/prompts/evaluator.ts` | Keep queue-aware and host-clipboard-aware prompt. Remote replaces conditional routes with static NEXT_RECOMMENDED and clipboard output; other changes expand equivalent rules. |
| `packages/core/src/prompts/planner.ts` | Keep concise existing rules. Remote adds incident comments and longer explanatory examples, without a missing planner capability. |
| `packages/core/src/runtime/__tests__/evaluator-foreground-context.test.ts` | Keep both current queryTokenCount and legacy queryTokens diagnostic compatibility tests. |
| `packages/core/src/runtime/__tests__/evaluator-queue-schema.test.ts` | Keep deleted tests for actual queue IDs, empty queues, redaction and schema nonmutation; remote removes the corresponding protections. |
| `packages/core/src/runtime/__tests__/evaluator-stage-context.test.ts` | Do not import tests asserting rejected blanket entity/platform/context provider exclusions. |
| `packages/core/src/runtime/__tests__/evaluator.test.ts` | Keep deleted clipboard host capability and unsupported-effect rejection tests. |
| `packages/core/src/runtime/__tests__/facts-and-relationships-memory-skip.test.ts` | Comment-only incident context; identical test behavior. |
| `packages/core/src/runtime/__tests__/message-handler-stop-lexicon.test.ts` | Keep removed multilingual STOP decision coverage; do not require an English keyword for stopping. |
| `packages/core/src/runtime/__tests__/planner-loop-calendar-verified-receipt.test.ts` | Reject changed expectation skipping semantic evaluation on self-verified receipt; keep current intent verification. |
| `packages/core/src/runtime/__tests__/planner-loop-discovery.test.ts` | Keep removed draft-plus-explicit-discovery case; prior reply is not proof of current discovery. |
| `packages/core/src/runtime/__tests__/planner-loop-superseded-effect-failure.test.ts` | Exclude message-scoped failure supersession. A source message does not identify the failed target; same mutation parameters after stripping selectors cannot prove the same resource. Preserve target-bound tests. |
| `packages/core/src/runtime/__tests__/planner-loop-verified-intent-operation.test.ts` | Do not import helper tests for rejected lexical intent-completion shortcut. Operation-family match does not prove requested content or target. |
| `packages/core/src/runtime/__tests__/planner-loop-verified-prose-restatement.test.ts` | Do not import helper tests for rejected English restatement suppression; word sets and sample values do not prove semantic equivalence. |
| `packages/core/src/runtime/__tests__/planner-loop.test.ts` | Keep semantic evaluation and targeted second-call expectations; remote changes them to lexical completion and subset queue skipping. Current custom-template fallback and default shared-rule coverage already exist; no redundant import. |
| `packages/core/src/runtime/__tests__/planner-rendering.test.ts` | Do not import result-prefix truncation tests; complete result contract remains. |
| `packages/core/src/runtime/__tests__/terminal-proposal-whitespace.test.ts` | Keep deleted exact formatting and code indentation regression; remote normalization changes proposal evidence. |
| `packages/core/src/runtime/action-catalog.test.ts` | Keep removed no-search-metadata work avoidance test with equivalent complete schemas and localized examples. |
| `packages/core/src/runtime/action-catalog.ts` | Keep exact-name discovery avoiding unused search-index work; remote removes optimization. |
| `packages/core/src/runtime/evaluator.ts` | Keep executable queue ID schema and clipboard capability validation. Remote removes both; evaluatorBaseContext restoration is coupled to rejected blanket provider exclusions, not an independent fix for current composition. |
| `packages/core/src/runtime/planner-loop.ts` | Reject 60-percent intent word-overlap completion, argument-subset queue dropping, English restatement suppression and whitespace flattening. Preserve explicit discovery before draft evaluation and target-bound failure supersession. Keep current batch-scope placement: default template states it once and custom templates receive the full schema fallback. Separate evaluator context depends on rejected provider exclusions. |
| `packages/core/src/runtime/planner-rendering.ts` | Reject result-body truncation; complete receipts and outputs required. |
| `packages/core/src/runtime/planner-types.ts` | Reject context-exclusion prefix and loss of false clipboard capability; no import. |
| `packages/core/src/runtime/sub-planner.ts` | Comment expansion only; implementation identical. |
| `packages/core/src/runtime/trajectory-recorder.ts` | Exclude default14-day deletion and silent filesystem catches; preserve recorded evidence and explicit diagnostics. |
| `packages/core/src/runtime/trajectory-retention.test.ts` | Exclude with automatic retention feature; deleting aged temp fixtures does not justify changing evidence retention policy. |
| `packages/core/src/services/__tests__/history-quote-discovery.test.ts` | Keep chronological original-source attribution and eager exact quoted-source read tests, including stale/miss/duplicate/full restoration cases. |
| `packages/core/src/services/__tests__/history-search-receipts.test.ts` | Keep lossless repeated-original reassembly test separating speakers, occurrences and whitespace. |
| `packages/core/src/services/evaluator.input-budget.test.ts` | Do not import tests requiring oldest-history truncation and skipped-budget evaluation with empty errors; violates complete input contract. |
| `packages/core/src/services/evaluator.prompt-budget.test.ts` | Reject capped-results case. Current evaluator.test.ts covers identical vs differing shared blocks and full schema/native/json/plain evidence parity, including persisted results and task-specific system precedence. Suite passed; no duplicate import. |
| `packages/core/src/services/evaluator.test.ts` | Keep stronger current system precedence and byte-identical fallback evidence contract; current suite passed during reconciliation. |
| `packages/core/src/services/evaluator.ts` | Reject opt-in oldest-history and result-prefix trimming, and skipped-budget success telemetry. Keep dedicated extraction system contract and current native/text schema separation; remote refactor is not a missing capability. |
| `packages/core/src/services/message.runtime-failure-suppression.test.ts` | Keep removed401/402/403 single-model-attempt and provider-neutral failure delivery tests. |
| `packages/core/src/services/message.stage1-retry.test.ts` | Keep malformed/conflicting native decision rejection and identical-decision recovery tests. |
| `packages/core/src/services/message/context-assembly.ts` | Exclude alternate inline catalog projection: drops aliases/contexts/children and normalizes authored newlines. Current direct text already defers catalog via authorized discovery; retain complete other-channel path. |
| `packages/core/src/services/message/context-discovery.ts` | Keep explicit provider-reference versus routing-context distinction; remote weakens read guidance. |
| `packages/core/src/services/message/egress-policy.combined-verified-reply.test.ts` | Comment-only gate incident identifier; no behavioral delta. |
| `packages/core/src/services/message/egress-policy.ts` | Comment-only delta; no implementation needed. |
| `packages/core/src/services/message/failures.ts` | Keep terminal auth/credit handling and provider-neutral error wording; remote resumes fallback model calls after terminal account failures. |
| `packages/core/src/services/message/history-discovery.ts` | Keep native read/ready separation, scoped source-label repair, chronological quote dependency loading and lossless repeated-text encoding. Remote removes these newer safeguards/optimizations. |
| `packages/core/src/services/message/media-delivery.ts` | Keep generic URLs distinct from delivered media; remote adds generic url to media suppression. |
| `packages/core/src/services/message/pipeline.ts` | Keep exact-name discovered tool append, explicit unavailable clipboard and current complete evaluator composition. Remote replaces these with umbrella recollection, no-op clipboard callback and blanket provider exclusions. |
| `packages/core/src/services/message/processor.ts` | Keep forwarding initial provider failure for terminal auth/credit handling. |
| `packages/core/src/services/message/provider-state.ts` | Reject blanket evaluator provider exclusions; current context contract retains applicable constraints. |
| `packages/core/src/services/message/side-effect-claims.moved.test.ts` | Comment-only gate incident identifier; no behavioral delta. |
| `packages/core/src/services/message/stage1-decision.ts` | Keep one native decision, source-label repair and field prompt refresh after every authorized read. Remote removes parallelToolCalls=false and limits field refresh to one restoration path. |
| `packages/core/src/services/message/stage1-generation.ts` | Keep native decision rejection rather than fallback prose after an invalid HANDLE_RESPONSE. |
| `packages/core/src/services/message/stage1-input.ts` | Exclude voice-prewarm change from this text candidate; voice remains a separate acceptance gate. |
| `packages/core/src/services/message/stage1-output.ts` | Keep rejection of inconsistent native decisions; remote accepts first usable decision and prose fallback. |
| `packages/core/src/services/message/time-observations.test.ts` | Single English today-date case paired with excluded lexical shortcut; not broad current-time correctness proof. |
| `packages/core/src/services/message/time-observations.ts` | Exclude extra English current-date phrase shortcut: no selected scenario requires broadening this lexical override; preserve model-owned ordinary responses and the existing clock contract. |
| `packages/core/src/services/message/tool-discovery.test.ts` | Keep complete named schemas and explicit operation tests. Malformed-input coaching already exists; exclude permission-miss coaching reclassification to preserve admission failure authority. |
| `packages/core/src/services/message/tool-discovery.ts` | Keep description parameter schemas and requested-operation canonical grouping; remote strips schemas and restores flat expansion. Exclude permission-miss coaching: permission denial is not a malformed-input repair. |
| `packages/core/src/types/evaluator.ts` | Reject shared result character cap. |
| `packages/core/src/utils/batch-queue.test.ts` | Keep void drain contract with processed-item and error behavior tests; return-count assertions support excluded API-only change. |
| `packages/core/src/utils/batch-queue/index.ts` | Exclude drain return-count API change. Reviewed production call sites do not consume this count; no demonstrated candidate idle-backoff dependency or behavior benefit. |
| `packages/prompts/src/index.ts` | Comment-only incident narrative; no runtime prompt change to integrate. |
| `packages/shared/src/config/types.tools.ts` | Defer search configuration type removals with the settings migration; retain compatibility fields. |
| `packages/ui/scripts/duplicate-molecular-components-report.json` | Full parsed JSON objects equal; formatting only. Keep current generated report. |
| `packages/ui/src/components/developer/DeveloperReader.test.tsx` | Keep removed late background run, pagination/ownership, visibility, cancellation and explicit auth retry tests. |
| `packages/ui/src/components/developer/DeveloperTrajectories.tsx` | Keep late background-run polling and visibility/auth guards; remote removes them. |
| `packages/ui/src/components/developer/DeveloperWorkspace.test.tsx` | Keep removed relay-settlement and run-transition transcript resync tests. |
| `packages/ui/src/components/developer/DeveloperWorkspace.tsx` | Keep canonical transcript resync for normal app turns; remote removes it. |
| `packages/ui/src/components/developer/README.md` | Keep late background-run refresh, hidden-tab and auth-retry documentation; candidate retains that behavior. |
| `packages/ui/src/components/developer/trajectory-reader-data.test.ts` | Keep actual prompt-stage/purpose precedence tests removed remotely. |
| `packages/ui/src/components/developer/trajectory-reader-data.ts` | Keep actual prompt-stage identity above shared model-routing labels. |
| `packages/ui/src/hooks/useRealtimeVoiceMint.test.tsx` | Keep current late-start retry, unmount cancellation and force-free configured-runtime tests; review only, voice testing excluded. |
| `packages/ui/src/hooks/useRealtimeVoiceMint.ts` | Keep local eligibility and startup retry capability probing; remote requires force flag for local and removes retry. Voice testing excluded. |
| `plugins/plugin-app-control/AGENTS.md` | Keep lightweight direct-text destination handoff documentation; remote restores broader capability reference. Remote guide pair verified byte-identical. |
| `plugins/plugin-app-control/CLAUDE.md` | Keep lightweight direct-text destination handoff documentation; remote restores broader capability reference. Remote guide pair verified byte-identical. |
| `plugins/plugin-app-control/src/evaluators/view-context-planning.test.ts` | Keep direct-text destination identity/discovery cases; remote drops them and expects expanded capability text. |
| `plugins/plugin-app-control/src/evaluators/view-context-planning.ts` | Keep current lightweight direct-chat destination notice and programmatic surface behavior; remote restores extra capability detail. |
| `plugins/plugin-browser/AGENTS.md` | Keep promoted operation argument and session-metadata/page-read distinction. Remote guide pair verified byte-identical. |
| `plugins/plugin-browser/CLAUDE.md` | Keep promoted operation argument and session-metadata/page-read distinction. Remote guide pair verified byte-identical. |
| `plugins/plugin-browser/README.md` | Keep session metadata vs page-content distinction and narrowed promoted argument documentation. |
| `plugins/plugin-browser/src/actions/browser.test.ts` | Keep get/hover/fill exact dispatch and navigation selector/text exclusion tests. |
| `plugins/plugin-browser/src/actions/browser.ts` | Keep accurate session-metadata wording and per-subaction parameter ownership; remote weakens both. |
| `plugins/plugin-calendar/src/actions/calendar-attendees.test.ts` | Extra valid example domains and dotless syntax assertion: compare current attendee syntax coverage. No domain-based guessing accepted. |
| `plugins/plugin-calendar/src/actions/calendar-handler.attendee-grounding.test.ts` | Comment only; previous user source grounding assertion already present. |
| `plugins/plugin-calendar/src/actions/calendar-handler.schedule-token.test.ts` | Reject tests for English schedule-token field suppression; literal user field values must remain possible. |
| `plugins/plugin-calendar/src/actions/calendar-handler.travel-guard.test.ts` | Reject added title-echo location helper expectations; lexical noun overlap does not establish authorization. |
| `plugins/plugin-calendar/src/actions/calendar-handler.ts` | Reject bulk patch: English word/prefix heuristics drop literal fields and failed explicit IDs fall back to title mutation. Current grounded extraction, source-bound selectors and guest identity pause supersede this approach. |
| `plugins/plugin-calendar/src/actions/calendar-handler.update-field-debris.test.ts` | Reject helper suite for placeholder/English overlap/clear keyword shortcuts. Current user-grounded typed extraction owns intended fields. |
| `plugins/plugin-calendar/test/calendar-action-effect-receipts.test.ts` | Keep unresolved explicit target rejection. Current stated-field test at1734 preserves literal primary location and title-like description despite unrequested recurrence; no weaker corner-deli duplicate required. |
| `plugins/plugin-calendar/test/eliza-calendar.pglite.test.ts` | Relocated plain move is not new coverage. Current persisted omission/null/clear tests and date/duration plus exact description tests supersede older self-verification fixtures; prior29-test PGlite pass remains evidence, not rerun here. |
| `plugins/plugin-coding-tools/src/actions/web-fetch.test.ts` | Keep cancellation without fallback recommendation; remote positive fallback assertion cannot distinguish timeout from caller cancellation. |
| `plugins/plugin-coding-tools/src/actions/web-fetch.ts` | Exclude aborted-string fallback. Current fetch-guard uses bare abort for both timeout and caller cancellation, so the remote regex cannot distinguish them and may recommend more work after cancellation. |
| `plugins/plugin-notes/AGENTS.md` | Keep exact ID and complete content in same row; remote relaxes to separate positional IDs. Remote guide pair verified byte-identical. |
| `plugins/plugin-notes/CLAUDE.md` | Keep exact ID and complete content in same row; remote relaxes to separate positional IDs. Remote guide pair verified byte-identical. |
| `plugins/plugin-notes/README.md` | Keep exact-ID updates and ID/content row pairing documentation; remote describes rejected older behavior. |
| `plugins/plugin-notes/src/action.test.ts` | Keep removed exact-ID update/duplicate-title/ID-decoy/persisted-reopen and conflicting/unauthorized selector rejection tests. |
| `plugins/plugin-notes/src/action.ts` | Keep current exact-ID update and typed PATCH behavior; remote removes ID mutation support. |
| `plugins/plugin-notes/src/provider.test.ts` | Keep ID/content pairing, Unicode quoted titles and reordered duplicate-title binding tests; remote relaxes to positional strings. |
| `plugins/plugin-notes/src/provider.ts` | Keep source identities paired with full text; remote separates IDs into positional arrays. |
| `plugins/plugin-openai/README.md` | Keep exhausted transient429 shared retry budget documented alongside5xx. |
| `plugins/plugin-openai/__tests__/cross-tier-server-retry.real.test.ts` | Keep real-local-HTTP408/429 exhausted budget coverage across generated/live/buffered modes and distinct-model/new-call fallback. Remote narrows to503. |
| `plugins/plugin-openai/models/text.ts` | Keep exhausted429 retry suppression; remote drops rate-limit sharing. |
| `plugins/plugin-personal-assistant/src/actions/life.ts` | Keep reported task-store failure; remote silently converts a failed read into an absent hint. |
| `plugins/plugin-personal-assistant/src/providers/lifeops-connector-lines.ts` | Comment expansion only; implementation identical. |
