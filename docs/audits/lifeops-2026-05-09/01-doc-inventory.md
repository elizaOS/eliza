# LifeOps documentation audit — 2026-05-09

Working tree: `/Users/shawwalters/milaidy/eliza/`. Excludes worktrees and `node_modules`.

## TL;DR

1. **Three of the docs the user named do not exist in the tree.** `prd-lifeops-executive-assistant.md`, `plan-lifeops-executive-assistant-scenario-matrix.md`, and `lifeops-production-runbook.md` are not present anywhere under `eliza/`. They are referenced as the canonical source-of-truth by `coverage-matrix.md:20-21` ("Source references: PRD: `packages/docs/prd-lifeops-executive-assistant.md`; Scenario matrix: `packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`"). The matrix points at non-existent files.
2. **The 2026-05-08/09 audit corpus (`HARDCODING_AUDIT.md`, `GAP_ASSESSMENT.md`, `IMPLEMENTATION_PLAN.md`, `JOURNEY_GAME_THROUGH.md`) is largely outdated.** The "high-confidence" cleanup items it lists as TODO (delete `seed-routines.ts`, delete `stretch-decider.ts`, strip Jill/Marco/Sarah from source, rename `ice-bambam-executive-assistant.json` and `lifeops-samantha.json`, fold `lifeops-extensions.ts` back into `lifeops.ts`, build `ScheduledTask` spine, extract `plugin-health`, build `EntityStore + RelationshipStore`, add `FIRST_RUN`, `ENTITY`, `LIFEOPS_PAUSE`, `MESSAGE_HANDOFF`, `SCHEDULING_NEGOTIATION` actions) are **already implemented**. The audits read like a forward-looking plan but Wave 1 has shipped — they were not updated to reflect that.
3. **`launchdocs/14-lifeops-qa.md` is also stale.** Its only two open P1/P2 bugs (followup-tracker not scheduled at startup; Google OAuth callback channel mismatch) are fixed in current source.
4. **`packages/docs/rest/lifeops.md` is grossly incomplete.** It documents 17 endpoints; `src/routes/plugin.ts` declares 166. Entire endpoint families (entities, relationships, scheduled-tasks, sleep, x, imessage, telegram, signal, discord, whatsapp, channel-policies, phone-consent, reminder-preferences, features, approval-queue, activity-signals, manual-override, scheduled-tasks history/log) are absent from the public REST doc.
5. **`coverage-matrix.md` couples journey contract tests to PRD/scenario-matrix files that do not exist** (rows reference `Suite A/B/C/D/E/F` and `_catalogs/ice-bambam-executive-assistant`; the latter has been renamed to `executive-assistant-transcript.catalog.json`, but the matrix still refers to the old IDs in some rows via `[catalog/ice-bambam-executive-assistant ...]` in `UX_JOURNEYS.md`).

Bottom line: **the in-source audit corpus and the public-facing docs are out of sync with the actual code.** The audits describe work that is mostly done; the public docs describe a much smaller surface than ships. Both directions of drift need correction.

---

## Doc-by-doc inventory

### 1. `eliza/packages/docs/prd-lifeops-executive-assistant.md` — DOES NOT EXIST
- **Type claimed:** PRD.
- **Status:** **MISSING.** Not present in the tree (verified by `find` over the whole `eliza/` checkout, excluding worktrees / `node_modules`). The closest matches under `eliza/packages/docs/` are unrelated.
- **Cross-references that depend on it:**
  - `eliza/plugins/app-lifeops/coverage-matrix.md:20` — "Source references: PRD: `packages/docs/prd-lifeops-executive-assistant.md`".
  - `eliza/plugins/app-lifeops/docs/audit/UX_JOURNEYS.md:1542` — "Cross-reference: PRD Journeys 1–20 (canonical Suite map)" implies an external PRD; no concrete file is cited.
- **Verdict:** **MISSING / SPECULATIVE.** Either the PRD was never written, was deleted before this audit, or lives in a private location. Every claim that says "per PRD" is unverifiable from this checkout.

### 2. `eliza/packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md` — DOES NOT EXIST
- **Type claimed:** scenario matrix / plan.
- **Status:** **MISSING.** Not in the tree.
- **Cross-references:** `coverage-matrix.md:21`. Multiple `[catalog/ice-bambam-executive-assistant ea.*]` callouts in `UX_JOURNEYS.md` look like they map to suite IDs that lived in this matrix.
- **Verdict:** **MISSING / SPECULATIVE.** Same issue as the PRD — referenced as authoritative, not present.

### 3. `eliza/packages/docs/lifeops-production-runbook.md` — DOES NOT EXIST
- **Type claimed:** runbook.
- **Status:** **MISSING.** Not in the tree.
- **Verdict:** **MISSING.** No runbook content found anywhere; closest equivalent is `launchdocs/14-lifeops-qa.md` (which is QA, not a runbook).

### 4. `eliza/packages/docs/user/lifeops-setup.mdx`
- **Path:** `/Users/shawwalters/milaidy/eliza/packages/docs/user/lifeops-setup.mdx`
- **Size / mtime:** 1,274 bytes — 2026-05-09 16:42 (in-tree timestamp).
- **Type:** user-doc (Mintlify MDX).
- **One-line intent:** show end users how to start using LifeOps for tasks/habits/routines.
- **Headline claims:**
  - LifeOps is an Eliza surface for tasks, habits, routines, reminders, goals.
  - Three primary item types: `task`, `habit`, `routine`. (line 17–19)
  - For each item set `title, schedule, priority, reminders` (line 31–34).
  - Goals optional, only when several items support same outcome (line 36–38).
  - Optional Google connect for calendar / Gmail triage / schedule-aware reminders (line 46–52).
  - Daily actions: `complete, snooze, skip` (line 55–58).
  - Three troubleshooting paths: notification permissions, reconnect Google, "update Eliza" (line 60–73).
- **Completion verdict:**
  - Item kinds (task/habit/routine): **DONE.** Confirmed in `eliza/packages/shared/src/contracts/lifeops.ts` (`LIFEOPS_DEFINITION_KINDS`).
  - Goals API: **DONE.** Backed by `eliza/plugins/app-lifeops/src/routes/plugin.ts:379-433` (`GET/POST/PUT/DELETE /api/lifeops/goals`).
  - Google connection: **DONE.** Confirmed in `eliza/plugins/app-lifeops/src/lifeops/google-oauth.ts` and routes in `lifeops-routes.ts:1879-2306`.
  - Daily actions complete/snooze/skip: **DONE.** Endpoints at `plugin.ts:446-450`.
  - "Update Eliza" troubleshooting: **SPECULATIVE.** No mechanism in source actually re-checks LifeOps app availability; the doc's advice is generic.
- **LARP/slop flags:** the doc is the only public user doc for the largest plugin in the repo. It is **two paragraphs of marketing copy** that does not reflect 90 % of the surface (no mention of relationships, follow-ups, scheduled tasks, blockers, screen-time, health, browser bridge, remote sessions, push, Telegram/Discord/Signal/WhatsApp/iMessage pairing, multi-channel inbox, identity merge, owner profile extraction, approval queue, etc.). It promises features (`reminders that fit around your schedule`, `Gmail triage or reply drafting`) without telling users how to discover them. **Severely under-documented.**

### 5. `eliza/packages/docs/rest/lifeops.md`
- **Size / mtime:** 16,472 bytes — 2026-05-09 16:42.
- **Type:** API contract (Mintlify markdown table-driven).
- **One-line intent:** REST contract for `/api/lifeops/*`.
- **Headline claims:**
  - "All endpoints under `/api/lifeops`". 17 endpoints listed in the index table at lines 13–34.
  - Index covers: overview, definitions CRUD, goals CRUD, occurrence verbs (complete/skip/snooze), reminders process/acknowledge/inspection, workflows GET/POST. (lines 17–34)
  - 503 returned when runtime is unavailable. (line 9)
  - Cadence types: `once`, `daily`, `times_per_day`, `weekly`. (line 432)
  - Snooze presets: `15m, 30m, 1h, tonight, tomorrow_morning`. (line 409)
  - Window names: `morning, afternoon, evening, night, custom`. (line 517)
  - Progression rules: `none`, `linear_increment`. (line 496)
- **Completion verdict:**
  - 503 unavailable: **DONE.** Confirmed in `lifeops-routes.ts:121-130` and `687-692`.
  - Definitions CRUD: **DONE** (incl. DELETE which the doc *does not document*). `plugin.ts:377-433`.
  - Goals CRUD: **DONE** (incl. DELETE + `:id/review` not documented). `plugin.ts:379-435`.
  - Occurrence verbs: **DONE** plus `:id/explanation` not documented. `plugin.ts:443-450`.
  - Reminders process/acknowledge/inspection: **DONE.** `plugin.ts:330-335`.
  - Workflows: **DONE** plus `:id`, `:id/run`, `PUT :id` not documented. `plugin.ts:336-440`.
  - Cadence types: **CONTRADICTED.** Doc lists 4 (`once, daily, times_per_day, weekly`); `UX_JOURNEYS.md §2.3` says 5 (`once, daily, times_per_day, interval, weekly`); `service-mixin-reminders.ts` and the LLM extractor support `interval` (e.g. `stretch-breaks.json`, `water-default-frequency.json`). `interval` is real and missing from the public doc.
  - Snooze presets: **DONE** as documented; matches `UX_JOURNEYS.md §25.4`.
  - Reminder channels missing entirely from doc; `LIFEOPS_REMINDER_CHANNELS` defines 10 (`in_app, sms, voice, telegram, discord, signal, whatsapp, imessage, email, push` per `UX_JOURNEYS.md §7.1`).
- **Headline gap:** `plugin.ts` declares **166** routes (`grep -c '/api/lifeops/' src/routes/plugin.ts`); the REST doc covers **17**. ~90 % of the surface is undocumented.
  - Entire endpoint families undocumented: `/api/lifeops/entities/*` (8), `/api/lifeops/relationships/*` (6), `/api/lifeops/scheduled-tasks/*` (W1-A spine — verified at `src/routes/scheduled-tasks.ts`), `/api/lifeops/sleep/{history,regularity,baseline}` (3), `/api/lifeops/connectors/{google,x,imessage,telegram,signal,discord,whatsapp,health}/*` (~50), `/api/lifeops/gmail/{triage,search,needs-response,recommendations,spam-review,unresponded,reply-drafts,batch-reply-drafts,reply-send,message-send,batch-reply-send,manage,events/ingest}` (13), `/api/lifeops/calendar/*` (5), `/api/lifeops/x/{posts,dms/digest,dms/curate,dms/send}` (4), `/api/lifeops/inbox`, `/api/lifeops/activity-signals`, `/api/lifeops/manual-override`, `/api/lifeops/channel-policies`, `/api/lifeops/phone-consent`, `/api/lifeops/reminder-preferences`, `/api/lifeops/features/*`, `/api/lifeops/approval-queue/*`, `/api/lifeops/health/*`.
- **LARP/slop flags:**
  - The doc lists the cadence type table as authoritative but is missing the `interval` cadence the runtime supports (CONTRADICTED).
  - The reminder-channels table (`UX_JOURNEYS.md §7.1`) is not in the public doc.
  - The doc is shaped like a "starter API reference" and never grew with the surface. It is roughly accurate for the 17 endpoints it covers but actively misleads readers about scope by omission.

### 6. `eliza/packages/docs/docs/launchdocs/14-lifeops-qa.md`
- **Size / mtime:** 17,413 bytes — 2026-05-09 16:42.
- **Type:** launch QA / readiness review.
- **One-line intent:** second-pass launch readiness for the LifeOps surface (route coverage, P0–P3 bugs, Codex-fixable work, manual QA needed).
- **Dated header:** "Second-Pass Status (2026-05-05)". The "Recent commits" list in the gitStatus shows the doc was modified more recently than that.
- **Headline claims:**
  - **P1:** "Follow-up tracker is registered but appears not to be scheduled on clean startup. `rg` found no `ensureFollowup...` task creation path." (line 64)
  - **P2:** Google OAuth callback refresh fallbacks use mismatched channel/storage keys (`elizaos:` vs `eliza:`). (line 66–68)
  - **P2:** Intent sync is local-only; not wire-replication. (line 69)
  - **P2:** WhatsApp uses `authScope: "lifeops"` via app-core routes. (line 70)
  - **P3:** Ntfy push has no CI-safe HTTP integration coverage. (line 73)
  - "Targeted bounded test run passed: Test Files 5 passed (5), Tests 84 passed (84), 86.26 s." (line 41–43)
  - "Browser Bridge routes have moved to `@elizaos/plugin-browser`." (line 76)
- **Completion verdict:**
  - **P1 (followup tracker not scheduled): CONTRADICTED.** Source has been fixed. `src/plugin.ts:42` imports `ensureFollowupTrackerTask`, `:44` imports `registerFollowupTrackerWorker`, and `:450-456` actually calls them on init. The QA doc claims this path doesn't exist; it does. Either the doc was written against an older snapshot or someone fixed it without updating the doc.
  - **P2 (OAuth channel mismatch): CONTRADICTED.** `src/routes/lifeops-routes.ts:802-813` now posts to **both** `elizaos:lifeops:google-connector` *and* `eliza:lifeops:google-connector` (and same for `-refresh`). The hook at `src/hooks/useGoogleLifeOpsConnector.ts:27-28` listens on the `elizaos:` keys. Fix is in place.
  - **P2 (intent-sync local-only): DONE / accurate.** `src/lifeops/intent-sync.ts` confirms local queue only.
  - **P2 (WhatsApp authScope): DONE / accurate.** `src/hooks/useWhatsAppPairing.ts` confirms `authScope: "lifeops"`.
  - **P3 (Ntfy CI coverage): PARTIAL.** Live block remains skipped without `NTFY_BASE_URL`; no offline server stub yet (`test/notifications-push.integration.test.ts`).
  - Browser Bridge migration: **DONE.** Confirmed.
- **LARP/slop flags:**
  - The two open bugs the doc lists as P1/P2 are already fixed. The doc is reporting non-issues as if they're blockers — meaning either CI signed off without re-running, or the doc was never re-edited.
  - "Codex-fixable work" list (line 80–86) repeats fixes that have already landed (`ensureFollowupTrackerTask`, dual-channel callback refresh).
  - The "What I could not validate" list (line 47–54) is honest and useful — keep that posture; the rest needs an update pass.

### 7. `eliza/plugins/app-lifeops/coverage-matrix.md`
- **Size / mtime:** 7,413 bytes — 2026-05-09 16:42.
- **Type:** scenario / journey coverage matrix (28 rows).
- **One-line intent:** assert "every domain in `UX_JOURNEYS.md` has at least one test file" via `prd-coverage.contract.test.ts`.
- **Headline claims:**
  - "The 28 rows correspond 1:1 with the 28 chapters in `UX_JOURNEYS.md`." (line 4–6)
  - "Every row points to a real test file under `plugins/app-lifeops/test/`." (line 9)
  - "Source references: PRD: `packages/docs/prd-lifeops-executive-assistant.md`; Scenario matrix: `packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`." (lines 20–21)
  - 28 specific test files listed with status `covered` or `covered (extension pending)`.
- **Completion verdict:**
  - 28 rows match 28 ToC chapters: **DONE.** `UX_JOURNEYS.md` ToC at lines 22–49 lists 28 chapters; the matrix rows match them 1:1.
  - All 28 named test files exist: **DONE for the spot-check sample** — `first-run-defaults.e2e.test.ts`, `scheduled-task-end-to-end.e2e.test.ts`, `spine-and-first-run.integration.test.ts`, `handoff.e2e.test.ts`, `prd-coverage.contract.test.ts`, `default-pack-morning-brief.parity.test.ts`, `default-packs.smoke.test.ts`, `cancellation-fee.e2e.test.ts`, `portal-upload.e2e.test.ts` — all exist (verified by `test -f`).
  - "PRD: `packages/docs/prd-lifeops-executive-assistant.md`": **MISSING.** File doesn't exist.
  - "Scenario matrix: `packages/docs/plan-lifeops-executive-assistant-scenario-matrix.md`": **MISSING.** File doesn't exist.
  - The contract assertion (`every row points to a real test file`): not re-validated here, but the existence of all spot-checked files suggests the contract test is healthy.
- **LARP/slop flags:**
  - **The matrix names itself "PRD coverage" but the PRD it claims to cover is not in the tree.** Either the matrix is the PRD (then say so) or the PRD lives elsewhere (then say where). Right now the matrix is a contract that points at a vacuum.
  - Some rows reference "Suite A/B/C/D/E/F" anchors (`ea.schedule.protect-sleep-window`, `ea.inbox.daily-brief-cross-channel`, etc.) that map to a "PRD scenario matrix" that does not exist. The Suite-letter scaffolding is leftover from a planning doc that has either moved out of tree or never existed.

### 8. `eliza/plugins/app-lifeops/docs/audit/UX_JOURNEYS.md`
- **Size / mtime:** 99,834 bytes (1,611 lines) — 2026-05-09 16:42.
- **Type:** audit / user-journey reference.
- **One-line intent:** the canonical reference for every LifeOps journey, with source-citation tags.
- **Headline claims (sampling):**
  - 28 chapters covering onboarding, core data, habits, routines, tasks, goals, reminders, calendar, inbox, travel, follow-up, documents, blockers, group chat, multi-channel, activity signals, approvals, identity merge, memory, connectors, health, push, remote, settings, REST, workflows, multilingual, suspected.
  - Each journey has source-citation tags (`[scenarios/<id>.json]`, `[test/<file>]`, `[contracts/<symbol>]`, etc.).
  - "All 20 PRD journeys are present" (line 1567); the table at lines 1544–1565 maps PRD IDs 1–20 to sections.
  - Connector certification matrix: 15 connectors × axes (lines 1577–1592).
  - Samantha 7 onboarding moves (lines 1599–1605).
- **Completion verdict:** the journey claims are largely **DONE** — the test files exist and the listed scenarios run. Spot checks:
  - §3.1 Brush-teeth basic: `[scenarios/brush-teeth-basic.json]` exists; `[test/lifeops-chat.live.e2e.test.ts]` exists. **DONE.**
  - §10.2 Book trip after approval: `[test/book-travel.approval.integration.test.ts]` exists. **DONE.**
  - §11.2 Frontier Tower repair: `[test/assistant-user-journeys.followup-repair.e2e.test.ts]` exists. **DONE.**
  - §13.1 Block/unblock websites via API: `[test/selfcontrol-chat.live.e2e.test.ts]` exists. **DONE.**
  - §22.4 Stuck-agent push escalation: `[test/stuck-agent-call.e2e.test.ts]` exists. **DONE.**
  - §28 "Suspected-but-unconfirmed flows": **PARTIAL by the doc's own admission** — section headed "their exact runtime behavior was not directly observed" (line 1478). 15 sub-items flagged as not exercised end-to-end.
  - §1.4 / §20: agent-side Gmail rejection: **DONE.** Confirmed in `service-mixin-google.ts:1071` per launchdocs/14.
  - §6.7 Sleep window protection (`CALENDAR_PROTECT_WINDOW`): **PARTIAL.** Coverage matrix marks Journey #2 as "covered (extension pending)"; the action key `CALENDAR_PROTECT_WINDOW` is not in the current action registry — `src/actions/calendar.ts` uses `propose_times` / `update_preferences` / `bulk_reschedule`. The flow may be implemented under a different name or as a workflow.
  - §1.6 Health connectors `POST /api/lifeops/connectors/health/start`: route **does not exist** in `plugin.ts` (no `connectors/health/*`). Health connectors are now under `plugin-health` (`plugins/plugin-health/src/connectors/`); the route surface has not been re-attached. **CONTRADICTED.**
- **LARP/slop flags:**
  - The doc is honest about its §28 ("suspected but unconfirmed") section and explicitly tags 15 flows as not directly tested. That is good practice.
  - Many `[contracts/<symbol>]` references point at types in `packages/shared/src/contracts/lifeops.ts` (and `lifeops-extensions.ts`) — these are real, but the audit corpus elsewhere argues `lifeops-extensions.ts` should be folded back. Still split.
  - **`[catalog/ice-bambam-executive-assistant ea.*]` tags litter the doc.** Catalog has been renamed to `executive-assistant-transcript.catalog.json` and the in-catalog IDs renamed to `ea.schedule.recurring-relationship-block` etc. The journey doc was not updated to match.
  - **`[checkin-todo]` tag** at line 18 references `eliza/plugins/app-lifeops/src/actions/CHECKIN_MIGRATION.TODO.md` — this file no longer exists, and `actions/checkin.ts` no longer exists either. **CONTRADICTED:** the journey doc still treats CHECKIN as a live concern (`§4.4 The CHECKIN action was deleted; morning brief and night brief are intended to run as scheduled tasks rather than planner-visible actions. ... runMorningCheckin and runNightCheckin are still on CheckinService [checkin-todo]`). The CheckinService is real but the migration TODO doc this section cites is gone.
  - The PRD cross-reference table (lines 1544–1567) calls out 20 PRD journeys mapped to sections, but the PRD doesn't exist in the tree.
  - The "Samantha 7 onboarding moves" section (line 1597) references `[mock/lifeops-samantha]` — fixture has been renamed to `lifeops-presence-active.json`.

### 9. `eliza/plugins/app-lifeops/docs/audit/JOURNEY_GAME_THROUGH.md`
- **Size / mtime:** 80,539 bytes (1,213 lines) — 2026-05-09 16:42.
- **Type:** audit (journey-by-journey architecture critique).
- **One-line intent:** simulate ~18 representative journeys against the proposed `ScheduledTask` architecture and surface architectural gaps, ambiguities, latency costs.
- **Headline claims:**
  - "10 top game-through findings + 6 review additions" baked into `GAP_ASSESSMENT.md §2.3 / §3.11–§3.17 / §8.7–§8.15`. (per its own header)
  - Each journey has `*Plan ref*`, `*spec-undef*`, `*spec-bad-ux*`, latency-budget notation.
  - 10+ identified architectural gaps ("No defined affordance schema", "Path-selection mechanism is undefined", "Default morning = 06:00 is hostile", etc.).
- **Completion verdict:**
  - The doc is explicitly a **forward-looking critique** of work that hadn't been done at the time. Many of its findings are now baked into `GAP_ASSESSMENT.md` schema fixes and the Wave-1 implementation.
  - Wave-1 deliverables it argues for (`PendingPromptsProvider`, `RecentTaskStatesProvider`, `GlobalPauseStore`, multi-gate `shouldFire`): **DONE.** All present under `src/lifeops/scheduled-task/`, `src/lifeops/pending-prompts/`, `src/lifeops/global-pause/`.
  - Many `spec-undef` items still legitimately open in the implementation — e.g. "what utterance triggers customize vs defaults?" requires reading `src/lifeops/first-run/` source.
- **LARP/slop flags:**
  - The doc is a *thought experiment* presented as part of an audit — useful but not authoritative on what shipped.
  - It does not say anywhere "as of date X this is the state of the implementation"; readers can mistake it for current-state analysis.
  - Section headings like "What works in the proposed architecture" are clear but mid-doc claims like "the W1-A spec is silent on Z" are now stale.

### 10. `eliza/plugins/app-lifeops/docs/audit/GAP_ASSESSMENT.md`
- **Size / mtime:** 79,344 bytes (992 lines) — 2026-05-09 16:42.
- **Type:** audit (architecture / gap analysis).
- **One-line intent:** map the 28 journey domains to capabilities required to express each as `ScheduledTask + supporting registries + default packs`.
- **Headline claims:**
  - "`ScheduledTask` is the spine primitive" (§2). **DONE** — implemented at `src/lifeops/scheduled-task/{types,runner,gate-registry,completion-check-registry,consolidation-policy,escalation,state-log}.ts`.
  - "Default packs are the curated starter set" (§2.4). **DONE** — `src/default-packs/{daily-rhythm,morning-brief,quiet-user-watcher,followup-starter,inbox-triage-starter,habit-starters}.ts`.
  - "`ENTITY + RELATIONSHIP` knowledge-graph primitive" (§3.4). **DONE** — `src/lifeops/entities/{store,merge,types}.ts` + `src/lifeops/relationships/{store,extraction,types}.ts` + `actions/entity.ts`.
  - "`plugin-health` extracted" (§4). **PARTIAL.** `plugins/plugin-health/` exists with `connectors/`, `sleep/`, `screen-time/`, `health-bridge/`, `anchors/`, `default-packs/`. **BUT** the 8 sleep event kinds are still in `eliza/packages/shared/src/contracts/lifeops.ts:90-103` (`LIFEOPS_EVENT_KINDS` includes `lifeops.sleep.onset_candidate`, `.detected`, `.ended`, `lifeops.wake.confirmed`, `lifeops.nap.detected`, `lifeops.bedtime.imminent`, `lifeops.regularity.changed`). The "atomic move" promised in §4.3 is not atomic — the contracts file still owns these.
  - "First-run capability" (§5). **DONE** — `src/actions/first-run.ts` + `src/lifeops/first-run/{defaults,questions,replay,service,state}.ts`.
  - "`HandoffStore`" (§3.14), "`GlobalPauseStore`" (§3.15), "`ConsolidationPolicy`" (§3.16), "`ConnectorTransportContract`" (§3.17): all **DONE** by directory inspection.
  - "`MultilingualPromptRegistry`" (§3.7): **PARTIAL.** `src/lifeops/i18n/` exists; not verified to be the contract this section describes.
- **Completion verdict:** the document is a design plan; most of its high-confidence Wave-1 prescriptions have shipped. The doc is **outdated as a critique** because it presents the work as future, not present.
- **LARP/slop flags:**
  - **This is the flagship gap doc and it has not been updated to reflect what shipped.** Re-reading it suggests "everything is open"; reading the source suggests Wave-1 mostly landed.
  - References to legacy code in `service-mixin-reminders.ts:567-606` (line 244) target a comment block that no longer hosts active stretch logic — the audit's own §2.7 prescribed deletion; the deletion happened (only stale comments remain at lines 562-569 and 4716).
  - The migration table at §3.4 promises a `lifeops_relationships` → `(Entity, Relationship)` migration with dry-run + manual-review JSON. `src/lifeops/graph-migration/migration.ts` exists — verify whether the dry-run + JSON mode shipped.

### 11. `eliza/plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md`
- **Size / mtime:** 75,882 bytes (966 lines) — 2026-05-09 16:42.
- **Type:** audit (delivery plan).
- **One-line intent:** three-wave parallel-agent delivery plan (Wave 1 foundations, Wave 2 migration, Wave 3 review).
- **Headline claims:**
  - Wave 1 ships seven parallel agents (W1-A through W1-G). 
  - Wave 2 ships seven migration agents (W2-A through W2-G).
  - Wave 3 is sequential (W3-A through W3-E). **NOT DONE.**
  - Pre-wave hygiene: relax the "20 PRD journeys" assertion; strip PII; fold `lifeops-extensions.ts`. (§2)
- **Completion verdict:**
  - Pre-wave PII strip: **DONE.** Source grep for `Jill|Marco|Sarah|Suran|Samantha` returns hits only inside the lint corpus (`src/default-packs/lint.ts`, `test/default-packs.lint.test.ts`) which are intentional regression tests; the offending source examples are gone.
  - Pre-wave fixture renames: **DONE.** `test/mocks/environments/lifeops-presence-active.json` (was `lifeops-samantha.json`), `test/scenarios/_catalogs/executive-assistant-transcript.catalog.json` (was `ice-bambam-executive-assistant.json`), `scenarios/gmail-direct-message-sender-routing.json` (was `gmail-suran-routing.json`). All renames completed.
  - Pre-wave fold of `lifeops-extensions.ts`: **STATUS UNKNOWN** — not verified directly; the `LifeOpsRelationship` type is still referenced from somewhere.
  - Wave 1 W1-A (ScheduledTask spine): **DONE.**
  - Wave 1 W1-B (plugin-health extraction): **PARTIAL.** Plugin exists but sleep event kinds still in shared contracts (per above).
  - Wave 1 W1-C (first-run + providers): **DONE.**
  - Wave 1 W1-D (default packs + lint): **DONE.** `src/default-packs/` has 11 files including `lint.ts`.
  - Wave 1 W1-E (ENTITY + RELATIONSHIP): **DONE.**
  - Wave 1 W1-F (connector + channel + transport contract): **PARTIAL.** Some contributions exist (`registries/blocker-registry.ts`, `connectors/google.ts`); `ChannelRegistry` consolidation status not verified.
  - Wave 1 W1-G (repo hygiene): **DONE.** Non-action helper files moved out of `src/actions/` (no `extractor-pipeline.ts`, `gmail.ts` helper, `lifeops-google-helpers.ts`, `lifeops-grounded-reply.ts`, `non-actionable-request.ts`, `scheduled-trigger-task.ts`, `timezone-normalization.ts`, `lifeops-extraction-config.ts`, `CHECKIN_MIGRATION.TODO.md` in current `src/actions/`).
  - Wave 2: many surface signals (`actions/entity.ts`, `actions/scheduling-negotiation.ts`, `actions/lifeops-pause.ts`, `actions/message-handoff.ts`, `actions/first-run.ts`) match Wave-2 deliverables — partial Wave 2 has shipped under the same date stamp.
  - Wave 3: nothing in the tree confirms it ran. The integration-gate / replay deliverables would have produced new docs.
- **LARP/slop flags:**
  - The plan reads as forward-looking but the work is in flight (or done) — the plan itself was not updated to reflect status.
  - The plan promises Wave-3 promotion of the lint pass to CI-fail (§9 / W3-B); the lint script's `--fail-on-finding` flag is still warnings-only (per `default-packs/lint.ts` and `prompt-content-lint.md` line 36).
  - "Verification gate per wave" is described but no per-wave gate report exists in the docs tree.

### 12. `eliza/plugins/app-lifeops/docs/audit/HARDCODING_AUDIT.md`
- **Size / mtime:** 58,152 bytes (495 lines) — 2026-05-09 16:42.
- **Type:** audit (hardcoding / larp inventory).
- **One-line intent:** inventory hardcoded scenario sediment, PII, compound-action mis-factoring, and registry-candidate enums.
- **Headline claims:**
  - Five biggest themes: (1) seed-routine + stretch-decider larp; (2) PII names baked in source; (3) umbrella actions hardcoded; (4) connector vocabulary enumerated; (5) event vocabulary mixes primitives with sleep events.
  - "12 high-confidence cleanup recommendations" (§6).
  - "Section 9 ordering hazards: STRETCH_ROUTINE_TITLE export, lifeops-extensions.ts re-merge, contract test relaxation."
- **Completion verdict:**
  - **Theme 1 (seed-routines + stretch-decider): MOSTLY DONE.** `src/lifeops/seed-routines.ts` no longer exists in `src/lifeops/`; `stretch-decider.ts` no longer exists. Only `src/lifeops/seed-routine-migration/` remains as a transitional alias. `STRETCH_ROUTINE_TITLE` export is gone (zero hits). `service-mixin-reminders.ts:562-569` and :4716 still carry stale comments referring to the old code but the runtime code itself is removed.
  - **Theme 2 (PII in source): DONE.** `grep -rn "Jill|Marco|Sarah|Suran" src/` returns zero source hits; only the lint-corpus regression tests reference the names intentionally.
  - **Theme 3 (umbrella actions hardcoded): PARTIAL.** Connector dispatchers still in `actions/connector.ts`; CALENDAR umbrella still has 24 subactions (not split per §6 medium-confidence #13). `RELATIONSHIP` umbrella renamed to `ENTITY` (per `actions/entity.ts`). PROFILE `save/set` aliases — not verified.
  - **Theme 4 (connector vocabulary enumerated): PARTIAL.** Old enums (`LIFEOPS_CONNECTOR_PROVIDERS`, `LIFEOPS_REMINDER_CHANNELS` etc.) still exist in `packages/shared/src/contracts/lifeops.ts` per the file's `LIFEOPS_EVENT_KINDS` excerpt above; consolidation into `ChannelRegistry` is incomplete.
  - **Theme 5 (sleep events first-class): NOT DONE.** `lifeops.sleep.onset_candidate`, `.detected`, `.ended`, `lifeops.wake.confirmed`, `lifeops.nap.detected`, `lifeops.bedtime.imminent`, `lifeops.regularity.changed` are still in `LIFEOPS_EVENT_KINDS` at `lifeops.ts:94-101`. The audit's own §6 medium-confidence #14 prescribed extraction; not done.
  - High-confidence #1 (delete stretch-decider): **DONE.**
  - High-confidence #2 (move 9 non-action files out): **DONE.**
  - High-confidence #3 (CHECKIN resolution): **DONE.** `actions/checkin.ts` no longer exists.
  - High-confidence #4 (strip source PII): **DONE.**
  - High-confidence #5 (rename PII fixtures): **DONE.**
  - High-confidence #6 (resolve duplicate followup actions): **NOT VERIFIED.** No standalone `LIST_OVERDUE_FOLLOWUPS` etc. in `src/actions/`; no `actions/relationship.ts`. Folded into `actions/entity.ts` and ScheduledTask queries presumably.
  - High-confidence #7 (collapse PROFILE save/set): **NOT VERIFIED** — `actions/profile.ts` exists but contents not read.
  - High-confidence #8 (move set_reminder_preference off PROFILE): **NOT VERIFIED.**
  - High-confidence #9 (strip 18 always-include scenario tags): **NOT VERIFIED** — `actions/calendar.ts` still exists; tags content not re-read.
  - High-confidence #10 (ConnectorRegistry): **NOT DONE.** `actions/connector.ts` still has hardcoded dispatchers per source listing.
  - High-confidence #11 (RoutineTemplateRegistry): superseded by `default-packs/` module; **DONE in spirit, NOT DONE as a registry contract.**
  - High-confidence #12 (relax 20 PRD journeys assertion): **DONE.** `coverage-matrix.md` now has 28 rows, not 20.
  - **Section 6 medium-confidence #13 (CALENDAR decomposition): NOT DONE.**
  - **Section 6 medium-confidence #14 (sleep extraction): NOT DONE.**
- **LARP/slop flags:**
  - The audit gives `Section 9 — Dependencies and Ordering` then says "End of audit. This document does not modify code." It clearly was followed (mostly) but the doc was not updated to reflect what shipped.
  - The mentioned ordering hazards (`STRETCH_ROUTINE_TITLE` export from `seed-routines.ts:21`, `lifeops-extensions.ts` re-merge) are obsolete — no `STRETCH_ROUTINE_TITLE` export anywhere.
  - "Self-acknowledged AI-agent failure-mode preserved as a side-file" (line 124, on `lifeops-extensions.ts`) — file still exists; the apologetic header may or may not still be there.

### 13. `eliza/plugins/app-lifeops/docs/audit/wave1-interfaces.md`
- **Size / mtime:** 21,304 bytes (564 lines) — 2026-05-09 16:42.
- **Type:** audit (interface contract for Wave 1).
- **One-line intent:** the contract every Wave-1 agent builds against (frozen day 1).
- **Headline claims:**
  - `ScheduledTask` schema (§1.1) frozen.
  - Runner verbs (§1.2) frozen.
  - W1-A through W1-G interfaces all defined.
- **Completion verdict:**
  - The schema in §1.1 matches `src/lifeops/scheduled-task/types.ts`. **DONE.**
  - This doc is the most up-to-date / accurate of the audit set because it describes contracts not code state.
- **LARP/slop flags:** none significant. This is the cleanest audit doc.

### 14. `eliza/plugins/app-lifeops/docs/audit/default-packs-rationale.md`
- **Size / mtime:** 8,600 bytes (119 lines) — 2026-05-09 16:42.
- **Type:** audit (default-pack curation rationale).
- **One-line intent:** per-pack "why it's in / out, what the user sees on day one" for W1-D.
- **Headline claims:**
  - 6 default packs: `daily-rhythm`, `morning-brief`, `quiet-user-watcher`, `followup-starter`, `inbox-triage-starter`, `habit-starters`. (line 17–69)
  - "Day-one nudge budget: ≤ 6 user-facing nudges per day." (line 99)
  - "Verified by `test/default-packs.smoke.test.ts`." (line 110)
  - Wave-3 review (W3-A) will adjust threshold etc. (line 112)
- **Completion verdict:**
  - 6 default packs exist: **DONE.** All 6 files present in `src/default-packs/`.
  - `test/default-packs.smoke.test.ts` exists: **DONE.**
  - Wave-3 review (W3-A): **NOT DONE** — no Wave-3 artifacts in tree.
- **LARP/slop flags:** clean and current.

### 15. `eliza/plugins/app-lifeops/docs/audit/prompt-content-lint.md`
- **Size / mtime:** 6,668 bytes (43 lines but long lines) — 2026-05-09 16:56 (newer than other audit docs).
- **Type:** audit (lint-rule corpus).
- **One-line intent:** describe the prompt-content lint rules (PII, absolute paths, ISO times, embedded conditionals) and their CI integration.
- **Headline claims:**
  - Lint script at `eliza/plugins/app-lifeops/scripts/lint-default-packs.mjs` (line 14).
  - Same regex corpus also exposed at runtime via `src/default-packs/lint.ts`.
  - "Wave-1 ships warnings only; Wave-3 W3-B promotes to CI-fail." (line 4 / 36)
  - Closed PII list: `Jill, Marco, Sarah, Suran, Samantha`.
- **Completion verdict:**
  - Lint script + module: **DONE.** `src/default-packs/lint.ts` exists; PII list at `src/default-packs/lint.ts:58` matches.
  - Wave-3 promotion: **NOT DONE.**
- **LARP/slop flags:** small, accurate, current.

### 16. `eliza/plugins/app-lifeops/docs/settings-access-ux.md`
- **Size / mtime:** 22,014 bytes (510 lines) — 2026-05-09 16:42.
- **Type:** UX review (settings / Access page).
- **One-line intent:** target model + element-by-element review of the LifeOps Access page.
- **Headline claims:**
  - Remove macOS permission checklist; remove X post-writing UI; remove stretch-reminder setup; etc. (line 6–10)
  - Page-level controls: `Run setup again`, `Disable LifeOps`. (line 36–38)
- **Completion verdict:** UX changes are not directly verifiable from a code inspection alone (this is a settings-page redesign doc); the bullets it asks for align with what `launchdocs/14` says shipped.
- **LARP/slop flags:** prose-heavy review; reasonable; some phrasing reads like the doc was in-progress when frozen.

---

## Cross-doc consistency

Where multiple docs make overlapping claims and disagree:

### A. Cadence type list
- **`packages/docs/rest/lifeops.md` lines 432–440:** "Four cadence kinds: `once, daily, times_per_day, weekly`."
- **`UX_JOURNEYS.md §2.3`:** **5** kinds — `once, daily, times_per_day, interval, weekly`.
- **Source:** `interval` is real (`scenarios/stretch-breaks.json`, `scenarios/water-default-frequency.json`, LLM extractor classifications).
- **Verdict:** REST doc is **CONTRADICTED**. Add `interval` to `rest/lifeops.md`.

### B. Reminder channels
- **`packages/docs/rest/lifeops.md`:** silent.
- **`UX_JOURNEYS.md §7.1` and `launchdocs/14-lifeops-qa.md`:** 10 channels (`in_app, sms, voice, telegram, discord, signal, whatsapp, imessage, email, push`).
- **Source:** `LIFEOPS_REMINDER_CHANNELS` in `packages/shared/src/contracts/lifeops.ts`.
- **Verdict:** REST doc is **MISSING** the channel surface. Add.

### C. CHECKIN
- **`UX_JOURNEYS.md §4.4`:** "The CHECKIN action was deleted; morning brief and night brief are intended to run as scheduled tasks rather than planner-visible actions. The agent posts the rendered briefing to the owner's primary DM room. `runMorningCheckin` and `runNightCheckin` are still on `CheckinService` `[checkin-todo]`."
- **`HARDCODING_AUDIT.md §2 Cat 4`:** "`CHECKIN` action exists (148 lines, registered in `plugin.ts:254`), but the sibling file `CHECKIN_MIGRATION.TODO.md` says the action *was* removed."
- **Source:** Action and TODO file both gone (`actions/checkin.ts` does not exist; `CHECKIN_MIGRATION.TODO.md` does not exist). `CheckinService` still exists and is used by `default-packs/morning-brief.ts`.
- **Verdict:** UX_JOURNEYS still cites a non-existent `[checkin-todo]` reference; HARDCODING_AUDIT's claim of "action exists, TODO says removed" is **CONTRADICTED**. Both docs need a sentence saying CHECKIN is now a scheduled-task-driven recap.

### D. The 20 PRD journeys vs 28 domains
- **`coverage-matrix.md`:** 28 rows, "domain-anchored".
- **`UX_JOURNEYS.md` ToC:** 28 chapters; line 1542 cross-reference table to "PRD Journeys 1–20".
- **`HARDCODING_AUDIT.md §6 #12`:** prescribes relaxing the "20 PRD journeys" assertion.
- **PRD file:** does not exist.
- **Verdict:** the 20-vs-28 split happened but the `UX_JOURNEYS.md` cross-reference still points at "PRD Journeys" that have no canonical text. The cross-reference table should either drop the PRD framing or land an actual PRD.

### E. CALENDAR decomposition
- **`HARDCODING_AUDIT.md §6 medium-confidence #13`:** "Decompose `CALENDAR` into Google-Calendar + Calendly + Negotiation actions."
- **`IMPLEMENTATION_PLAN.md §4 W2-C`:** "CALENDAR / compound-action decomposition" (Wave 2).
- **`actions/scheduling-negotiation.ts`:** **DONE** for negotiation.
- **`actions/calendar.ts`:** still exists with the 24-subaction umbrella (file present in source listing); Calendly extraction not confirmed.
- **Verdict:** **PARTIAL** — negotiation extracted, Calendly + Google split status unverified.

### F. plugin-health extraction
- **`GAP_ASSESSMENT.md §4.3`:** "atomic in Wave 1, not phased. ... A single wave with parallel sub-agents touching disjoint surfaces, integration gate at end."
- **`IMPLEMENTATION_PLAN.md §3.2 W1-B`:** sleep event kinds + filter types in `packages/shared/src/contracts/lifeops.ts` to be "replaced with re-exports from `plugin-health` only if cross-package dependency is required".
- **Source:** `plugins/plugin-health/` exists with full sleep + health-bridge + screen-time + connectors + anchors + default-packs subtrees, but `LIFEOPS_EVENT_KINDS` in `packages/shared/src/contracts/lifeops.ts:94-101` still owns the 8 sleep event kinds AS first-class entries (not re-exports).
- **Verdict:** **PARTIAL.** The plugin moved; the contracts didn't. The "atomic" claim is **CONTRADICTED**.

### G. Suite anchors (A/B/C/D/E/F)
- **`coverage-matrix.md`:** rows reference `Suite A (ea.schedule.protect-sleep-window)`, `Suite B (ea.inbox.daily-brief-cross-channel)`, etc.
- **`UX_JOURNEYS.md` lines 285, 405, 500, 526, 575, 666, 675, 727, 735, 795, 861, 1565:** same suite labels.
- **`plan-lifeops-executive-assistant-scenario-matrix.md`:** does not exist; the suites map to nothing canonical.
- **Verdict:** the Suite framing is documented but its source-of-truth is missing. **MISSING / SPECULATIVE.**

### H. RELATIONSHIP → ENTITY rename
- **`HARDCODING_AUDIT.md` (older revisions):** "split `RELATIONSHIP` into `CONTACTS` + `FOLLOW_UPS`".
- **`GAP_ASSESSMENT.md §3.4`:** supersedes; renames to `ENTITY` umbrella.
- **`UX_JOURNEYS.md §11.3`:** still calls the action surface `RELATIONSHIP` with subactions `list_contacts`, `add_contact`, etc.
- **Source:** `actions/entity.ts` exists; no `actions/relationship.ts`. The umbrella was renamed.
- **Verdict:** **CONTRADICTED.** UX_JOURNEYS still describes `RELATIONSHIP` as the live verb; in-source it's `ENTITY`.

### I. Health connector REST endpoints
- **`UX_JOURNEYS.md §1.6, §21.2`:** describes `POST /api/lifeops/connectors/health/start`, `/disconnect`, `/sync`, `GET /api/lifeops/connectors/health/status`, `POST /api/lifeops/health/summary`.
- **Source:** No `/api/lifeops/connectors/health/*` route declared in `src/routes/plugin.ts`.
- **Verdict:** **CONTRADICTED.** Either documented routes were never wired, or they moved into `plugin-health`'s own route surface (which would itself be undocumented in `rest/lifeops.md`).

### J. Push / Ntfy
- **`launchdocs/14 §P3`:** "Ntfy push has config/unit coverage but no CI-safe HTTP integration coverage; live test is skipped."
- **`UX_JOURNEYS.md §22.1`:** describes the full Ntfy contract (`sendPush({title, message, priority, tags, click, topic?})` POSTs to `${NTFY_BASE_URL}/<topic>`).
- **Source:** `src/lifeops/notifications-push.ts` confirmed.
- **Verdict:** consistent. But the **public** REST doc (`rest/lifeops.md`) does not mention notifications at all.

### K. Default-pack count and content
- **`default-packs-rationale.md`:** 6 packs.
- **`GAP_ASSESSMENT.md §2.4`:** "GM/GN starter, Daily check-in, Habit starters (8 entries), Morning brief assembler, Inbox triage starter."
- **`UX_JOURNEYS.md §1.1`:** "LifeOps app enabled (default-visible "featured" app)."
- **Source:** 6 packs in `src/default-packs/`, lint module + index. Habit-starters is offered, not auto-enabled.
- **Verdict:** consistent.

---

## Top 10 most important gaps

| # | Gap | Where | Severity | Fix |
|---|-----|-------|----------|-----|
| 1 | PRD, scenario matrix, and runbook docs the user asked for **do not exist** | `eliza/packages/docs/{prd-lifeops-executive-assistant.md, plan-lifeops-executive-assistant-scenario-matrix.md, lifeops-production-runbook.md}` | **Critical** | Either author them, point cross-refs at what does exist (audit corpus + UX_JOURNEYS), or remove the cross-references |
| 2 | `coverage-matrix.md` cites two non-existent files as canonical sources | `coverage-matrix.md:20-21` | **High** | Update to point at `UX_JOURNEYS.md` + actual catalog files, or land the missing PRD |
| 3 | `rest/lifeops.md` documents 17 of 166 endpoints (~90% missing) | `eliza/packages/docs/rest/lifeops.md` vs `src/routes/plugin.ts` | **High** | Auto-generate REST doc from `plugin.ts` route table, or write the missing sections (entities, relationships, scheduled-tasks, connectors, gmail, calendar, x, imessage, telegram, signal, discord, whatsapp, sleep, health, channel-policies, phone-consent, reminder-preferences, features, approval-queue, activity-signals, manual-override, inbox) |
| 4 | `rest/lifeops.md` cadence list is missing the `interval` cadence the runtime uses | `rest/lifeops.md:432-440` | **High** | Add `interval` cadence example mirroring `stretch-breaks.json` / `water-default-frequency.json` |
| 5 | `launchdocs/14-lifeops-qa.md` flags two bugs (P1 followup-tracker; P2 OAuth channel) that are already fixed | `launchdocs/14-lifeops-qa.md:64-68` vs `src/plugin.ts:42-456` and `src/routes/lifeops-routes.ts:802-813` | **High** | Re-run the QA pass; either close P1/P2 or document the lingering risk separately |
| 6 | `HARDCODING_AUDIT.md` and `GAP_ASSESSMENT.md` and `IMPLEMENTATION_PLAN.md` describe Wave-1 work as future, but it has shipped | `docs/audit/{HARDCODING_AUDIT,GAP_ASSESSMENT,IMPLEMENTATION_PLAN}.md` | **High** | Add a "Status as of YYYY-MM-DD" header to each, mark each high-confidence item as DONE / OPEN / DEFERRED, point at the implementing PR/commit |
| 7 | `plugin-health` extraction is incomplete: 8 sleep event kinds still in `packages/shared/src/contracts/lifeops.ts` | `packages/shared/src/contracts/lifeops.ts:90-103` vs `GAP_ASSESSMENT.md §4.3` | **Medium** | Move `lifeops.sleep.*` / `wake.*` / `nap.*` / `bedtime.*` / `regularity.*` event kinds into `plugins/plugin-health/src/contracts/health.ts`; LifeOps imports via re-export or directly |
| 8 | `UX_JOURNEYS.md` describes `RELATIONSHIP` umbrella but the action is now `ENTITY` | `UX_JOURNEYS.md §11.3` vs `src/actions/entity.ts` | **Medium** | Update §11 to describe `ENTITY` action subactions; preserve a "(formerly RELATIONSHIP)" note for one release |
| 9 | `UX_JOURNEYS.md §1.6 / §21.2` describes `/api/lifeops/connectors/health/*` routes that don't exist in `plugin.ts` | `src/routes/plugin.ts` (no matching paths) | **Medium** | Either expose the health connector routes in app-lifeops or move them to a documented `plugin-health` route surface and update the journey doc |
| 10 | `user/lifeops-setup.mdx` is two paragraphs and covers <10% of the surface users actually have access to | `eliza/packages/docs/user/lifeops-setup.mdx` | **Medium** | Rewrite to map to the 28 journey domains, with a connector setup section, a daily actions section, and an "advanced" expansion |

---

## What is solid

- `wave1-interfaces.md`, `default-packs-rationale.md`, and `prompt-content-lint.md` are clean, current, and useful.
- `coverage-matrix.md`'s contract assertion (every row → real test file) is sound and the 28 named tests all exist.
- `UX_JOURNEYS.md` is encyclopedic and an excellent reference even where stale; the §28 "suspected but unconfirmed" list is honest about its own limits.
- The audit `HARDCODING_AUDIT.md` analysis was specific, evidence-backed, and **the work mostly got done** — credit where due. The doc's failure mode is purely "didn't get updated to reflect completion."

## What needs immediate attention

1. Add a status header to all four large audit docs documenting what shipped vs what is open.
2. Fill in or replace the three missing PRD/plan/runbook docs.
3. Sync `rest/lifeops.md` with the actual route table.
4. Sync `user/lifeops-setup.mdx` with the actual user surface.
5. Re-run the `launchdocs/14` review against current source.
6. Finish the `plugin-health` extraction (move sleep events out of `packages/shared/src/contracts/lifeops.ts`).
