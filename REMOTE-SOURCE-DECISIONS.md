# Remote file decisions

Reviewed source: `d0d478fe7dd` against shared merge `89a476f3d75`.
Candidate-specific dispositions; a hold is unresolved integration work, not acceptance.
All127 changed paths were inspected. Test decisions do not claim tests were run.

| Path | Decision and evidence |
| --- | --- |
| `packages/agent/src/actions/memories.test.ts` | Keep explicit pagination expectation; remote replaces error with first20 automatic results. Hold targetless-update create hint test with intent behavior review. |
| `packages/agent/src/actions/memories.ts` | Do not auto-page an unbounded search; retain explicit complete-scan pagination contract. Missing-update creation hint needs separate intent review. |
| `packages/agent/src/api/chat-routes.ts` | Remote delta is comment expansion only; no implementation to integrate. |
| `packages/agent/src/api/conversation-routes.ts` | Remote delta is comment expansion only; no implementation to integrate. |
| `packages/agent/src/config/schema.ts` | Hold keyed web-search settings retirement for config consumer/migration review; not a latency fix. |
| `packages/agent/src/config/schema.web-search-hints.test.ts` | Hold with keyed-search migration; tests cover hidden UI hints and legacy parsing, not all config consumers. |
| `packages/agent/src/config/zod-schema.agent-runtime.ts` | Comment-only dependency of held search-settings retirement. |
| `packages/agent/src/runtime/prompt-optimization.test.ts` | Keep missing/zero/requested/provider temperature distinction tests removed remotely. |
| `packages/agent/src/runtime/prompt-optimization.ts` | Keep missing-vs-zero temperature telemetry; remote fabricates zero and overwrites explicit zero. |
| `packages/app-core/scripts/dev-ui.mjs` | Keep force-flag-free local voice probing; voice acceptance remains excluded. |
| `packages/core/AGENTS.md` | Keep named description schemas, full alias reconstruction and exact history-read/source-repair contracts removed remotely. Remote guide pair verified byte-identical. |
| `packages/core/CLAUDE.md` | Keep named description schemas, full alias reconstruction and exact history-read/source-repair contracts removed remotely. Remote guide pair verified byte-identical. |
| `packages/core/README.md` | Keep documentation for dedicated post-turn instructions, native schema fallback, exact named-tool schemas and history/source repair. Remote removes these and describes held inline catalog projection. |
| `packages/core/src/__tests__/action-discovery-timing.test.ts` | Added discovery-owned context admission and contextless state identity case is useful; compare candidate coverage before importing to avoid redundant test-only changes. |
| `packages/core/src/__tests__/entities-format.test.ts` | Do not import tests requiring removal of image fields and normalized identity aliases; complete metadata contract remains. |
| `packages/core/src/__tests__/media-reply-sanitize.test.ts` | Keep removed regressions separating fetched source URLs from delivered media and preserving source citations. |
| `packages/core/src/__tests__/message-answer-clobber-rescue.test.ts` | Keep removed real message-flow source citation regression after WEB_FETCH. |
| `packages/core/src/__tests__/message-failure-reply.test.ts` | Keep no-extra-call credit/auth failures and domain/provider authorization distinction; remote relaxes call count and deletes cases. |
| `packages/core/src/__tests__/message-runtime-stage1.test.ts` | Keep native read/ready separation, bounded malformed-source repair, one-decision options and complete custom aliases. New discovery assertions require coverage comparison; do not import broad test rewrite. |
| `packages/core/src/__tests__/message-stable-prefix.test.ts` | Fixture-only optional actions/getRoom/reportError; no new assertion or missing behavior. |
| `packages/core/src/__tests__/message-stage1-action-catalog.test.ts` | Do not import pure formatting tests for held lossy inline catalog projection. |
| `packages/core/src/__tests__/message-stage1-context-catalog.test.ts` | New role/cache omission and routing metadata case needs existing coverage comparison; role-filter assertions sharpen existing tests, not implementation. |
| `packages/core/src/__tests__/tiered-action-surface.test.ts` | Keep removed channel/discovery/alias/complete-description tests; remote expects omitted children/aliases. Additional index-only assertions tied to remote projection, not new domain behavior. |
| `packages/core/src/entities.ts` | Reject arbitrary metadata/key omission and name normalization; preserve complete identity/provenance context. |
| `packages/core/src/features/advanced-capabilities/actions/message.ts` | Hold connector-family selection refactor for scoped routing tests; existing single-account behavior retained. |
| `packages/core/src/features/advanced-capabilities/evaluators/reflection-items.ts` | Reject shared action-result cap; complete result context required. |
| `packages/core/src/features/advanced-capabilities/experience/utils/experienceFormatter.test.ts` | Remote cases pin alternate WHY/rationale ordering; candidate preserves all values with its existing representation. Compare exact-byte coverage without importing label-specific expectations. |
| `packages/core/src/features/advanced-capabilities/experience/utils/experienceFormatter.ts` | Keep current byte-exact local reference; remote mainly rearranges WHY/RATIONALE. No required missing behavior established. |
| `packages/core/src/features/trajectories/TrajectoriesService.ts` | Hold automatic destructive retention policy; evidence preservation needed, no disk-pressure requirement in this candidate. |
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
| `packages/core/src/runtime/__tests__/planner-loop-superseded-effect-failure.test.ts` | Hold added message-scoped failure supersession with target correlation review. Existing distinct-resource rejection remains; reordering that case is equivalent. |
| `packages/core/src/runtime/__tests__/planner-loop-verified-intent-operation.test.ts` | Do not import helper tests for rejected lexical intent-completion shortcut. Operation-family match does not prove requested content or target. |
| `packages/core/src/runtime/__tests__/planner-loop-verified-prose-restatement.test.ts` | Do not import helper tests for rejected English restatement suppression; word sets and sample values do not prove semantic equivalence. |
| `packages/core/src/runtime/__tests__/planner-loop.test.ts` | Keep semantic evaluation and targeted second-call expectations; remote changes them to lexical completion and subset queue skipping. Standalone batch-scope description assertion is useful only with held custom-template placement review. |
| `packages/core/src/runtime/__tests__/planner-rendering.test.ts` | Do not import result-prefix truncation tests; complete result contract remains. |
| `packages/core/src/runtime/__tests__/terminal-proposal-whitespace.test.ts` | Keep deleted exact formatting and code indentation regression; remote normalization changes proposal evidence. |
| `packages/core/src/runtime/action-catalog.test.ts` | Keep removed no-search-metadata work avoidance test with equivalent complete schemas and localized examples. |
| `packages/core/src/runtime/action-catalog.ts` | Keep exact-name discovery avoiding unused search-index work; remote removes optimization. |
| `packages/core/src/runtime/evaluator.ts` | Keep executable queue ID schema and clipboard capability validation. Remote removes both; evaluatorBaseContext restoration is coupled to rejected blanket provider exclusions, not an independent fix for current composition. |
| `packages/core/src/runtime/planner-loop.ts` | Reject 60-percent intent word-overlap completion, argument-subset queue dropping, English restatement suppression and whitespace flattening. Preserve explicit discovery before draft evaluation and target-bound failure supersession. Hold independent shared batch-scope placement for custom-template coverage; default template already states it. Separate evaluator context depends on rejected provider exclusions. |
| `packages/core/src/runtime/planner-rendering.ts` | Reject result-body truncation; complete receipts and outputs required. |
| `packages/core/src/runtime/planner-types.ts` | Reject context-exclusion prefix and loss of false clipboard capability; no import. |
| `packages/core/src/runtime/sub-planner.ts` | Comment expansion only; implementation identical. |
| `packages/core/src/runtime/trajectory-recorder.ts` | Hold14-day deletion default and silent filesystem catches with trajectory retention feature. |
| `packages/core/src/runtime/trajectory-retention.test.ts` | Hold with unaccepted14-day file deletion policy. Tests cover temp fixtures but not evidence retention authorization. |
| `packages/core/src/services/__tests__/history-quote-discovery.test.ts` | Keep chronological original-source attribution and eager exact quoted-source read tests, including stale/miss/duplicate/full restoration cases. |
| `packages/core/src/services/__tests__/history-search-receipts.test.ts` | Keep lossless repeated-original reassembly test separating speakers, occurrences and whitespace. |
| `packages/core/src/services/evaluator.input-budget.test.ts` | Do not import tests requiring oldest-history truncation and skipped-budget evaluation with empty errors; violates complete input contract. |
| `packages/core/src/services/evaluator.prompt-budget.test.ts` | Reject capped action-results expectation; native/fallback schema parity and shared block dedup are useful existing behaviors to compare against current coverage. |
| `packages/core/src/services/evaluator.test.ts` | Keep extraction-specific system precedence and identical fallback evidence tests removed remotely. Shared prefix/schema assertions partly equivalent; no broad rewrite. |
| `packages/core/src/services/evaluator.ts` | Reject opt-in oldest-history and result-prefix trimming, and skipped-budget success telemetry. Keep dedicated extraction system contract and current native/text schema separation; remote refactor is not a missing capability. |
| `packages/core/src/services/message.runtime-failure-suppression.test.ts` | Keep removed401/402/403 single-model-attempt and provider-neutral failure delivery tests. |
| `packages/core/src/services/message.stage1-retry.test.ts` | Keep malformed/conflicting native decision rejection and identical-decision recovery tests. |
| `packages/core/src/services/message/context-assembly.ts` | Hold alternate inline catalog projection for channel-specific review. Remote drops aliases, contexts and promoted child entries and collapses description newlines; direct-text reference-only path already avoids this catalog cost. |
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
| `packages/core/src/services/message/stage1-input.ts` | Hold voice prewarm catalog change with voice acceptance; no current text fix. |
| `packages/core/src/services/message/stage1-output.ts` | Keep rejection of inconsistent native decisions; remote accepts first usable decision and prose fallback. |
| `packages/core/src/services/message/time-observations.test.ts` | Single added English today-date case paired with held lexical shortcut; not broad current-time correctness proof. |
| `packages/core/src/services/message/time-observations.ts` | Hold extra English current-date phrase shortcut; no demonstrated missing scenario in selected text acceptance. |
| `packages/core/src/services/message/tool-discovery.test.ts` | Keep complete named parameter evidence and explicit discovered operation tests. Remote coachingFailure and index JSON assertions depend on held routing/projection changes. |
| `packages/core/src/services/message/tool-discovery.ts` | Keep description parameter schemas and requested-operation canonical grouping; remote strips schemas and restores flat expansion. Coaching-marker delta requires separate permission-failure semantics review. |
| `packages/core/src/types/evaluator.ts` | Reject shared result character cap. |
| `packages/core/src/utils/batch-queue.test.ts` | Return-count expectations depend on held drain API change; processed items/error reporting unchanged. |
| `packages/core/src/utils/batch-queue/index.ts` | Hold with dependent idle-backoff feature; changed drain return type alone establishes no benefit. |
| `packages/prompts/src/index.ts` | Comment-only incident narrative; no runtime prompt change to integrate. |
| `packages/shared/src/config/types.tools.ts` | Hold search config type removals with settings migration; compatibility needs verification. |
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
| `plugins/plugin-calendar/test/calendar-action-effect-receipts.test.ts` | Keep unresolved explicit target rejection; remote expects fallback update/delete of another queried event. Preserve literal field values including primary/title text. Compare independent stated-field preservation coverage. |
| `plugins/plugin-calendar/test/eliza-calendar.pglite.test.ts` | Plain-move test relocated unchanged; optional planner fields added to create cases and comments/casts changed. Current request-grounded extraction and persisted duration/date regression supersede older self-verified receipt shape; compare coverage of unchanged-field preservation. |
| `plugins/plugin-coding-tools/src/actions/web-fetch.test.ts` | Keep cancellation without fallback recommendation. Remote treats all AbortErrors as timeout; requires real timeout-vs-user cancellation distinction. |
| `plugins/plugin-coding-tools/src/actions/web-fetch.ts` | Hold broad aborted-string fallback hint until cancellation versus transport failure is distinguished. |
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
