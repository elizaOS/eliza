> [!NOTE]
> **STATUS: SUPERSEDED — most items shipped.** See `eliza/docs/audits/lifeops-2026-05-09/REPORT.md` for the current state. The high-confidence cleanup recommendations in this doc (delete `seed-routines.ts`, delete `stretch-decider.ts`, strip Jill/Marco/Sarah from source, rename PII fixtures, fold helpers out of `actions/`, remove `CHECKIN`, relax 20-PRD-journey assertion) have all landed. Retained in place so commit-history references still resolve.

# LifeOps — Hardcoding, Larp, and Misfactoring Audit

**Scope:** `eliza/plugins/app-lifeops/src/` (~141 lifeops files, 28 actions, 8 providers, 7 routes), `eliza/packages/shared/src/contracts/lifeops*.ts`, `eliza/plugins/app-lifeops/scenarios/*.json`, `eliza/plugins/app-lifeops/test/scenarios/`, `eliza/test/mocks/environments/lifeops-*.json`.

**Method:** read every action's metadata + key handler logic, the contract file end-to-end, every scenario filename and PII fixture, the service composition, the seeded-routine module, and the coverage matrix.

**Date:** 2026-05-08.

---

## Section 1 — Executive Summary

LifeOps has the *bones* of a generic personal-life-operations engine — `LIFEOPS_DEFINITION_KINDS = ["task", "habit", "routine"]`, generic cadence shapes (once/daily/weekly/interval/times_per_day), a typed connector grant, a typed reminder plan, a typed workflow + event-trigger contract — but the implementation has accumulated **scenario-shaped sediment** on top of those primitives. The capability is generic; the surface, the seed data, the test surface, the action descriptions, and several decision helpers are not.

**Five biggest themes:**

1. **The seed-routine module + stretch-decider are full-blown LARP.** `src/lifeops/seed-routines.ts` ships a hardcoded list of eight scenarios (brush teeth, invisalign, drink water, stretch, vitamins, workout, shower, shave). `src/lifeops/stretch-decider.ts` is an entire 144-line module of *stretch-specific* dispatch rules (skip weekends, late-evening cutoff, walk-out reset, copy-rotation table) that hardcodes one user habit's UX into the codebase. `service-mixin-reminders.ts:571` even has `definition?.title === STRETCH_ROUTINE_TITLE` — string-literal title check inside the reminder dispatch loop.

2. **PII / fictional-character names are baked into source code, not just fixtures.** `Jill` (4 hits across `actions/calendar.ts`, `actions/lib/calendar-handler.ts`, `actions/lib/scheduling-handler.ts`), `Marco` (`actions/lib/scheduling-handler.ts`, `actions/calendar.ts`, `actions/resolve-request.ts`), `Sarah` (`actions/lib/scheduling-handler.ts`). These are inside action `tags`, action `description` strings, and inline `examples` — meaning they ship to the planner prompt at runtime. Plus a fictional Spanish brush-teeth example (`life.ts:3509`) hardcoded into the action's examples block.

3. **Umbrella actions are hardcoded compound-action switchboards.** `CALENDAR` has 24 subactions (calendly_*, negotiate_*, propose_times, bulk_reschedule, …). `CONNECTOR` has a closed `VALID_CONNECTORS` enum + a `CONNECTOR_DISPATCHERS` `satisfies Record<ConnectorKind, ...>` map — adding a new connector requires editing the action. `LIFE` has 7 verbs × 2 kinds with an internal `toInternalLifeOp` switch. Every umbrella has a `SubactionsMap` that's enumerated, not registered.

4. **The connector vocabulary is enumerated, not extensible.** `LIFEOPS_CONNECTOR_PROVIDERS` (12 names), `LIFEOPS_REMINDER_CHANNELS` (10), `LIFEOPS_CHANNEL_TYPES` (12), `LIFEOPS_MESSAGE_CHANNELS` (9), `LIFEOPS_GOOGLE_CAPABILITIES` / `LIFEOPS_X_CAPABILITIES` / `LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES` / `LIFEOPS_SIGNAL_CAPABILITIES` / `LIFEOPS_DISCORD_CAPABILITIES` / `LIFEOPS_TELEGRAM_CAPABILITIES` are all per-provider enumerated unions. No connector contract — just a hand-maintained collection of provider-specific shapes.

5. **The event vocabulary mixes primitives with `lifeops.sleep.*` / `lifeops.bedtime.*` / `lifeops.nap.*` scenario events.** Of the 11 entries in `LIFEOPS_EVENT_KINDS`, 8 are sleep/wake/bedtime/nap/regularity-specific. There's *no* generic "habit.completed", "routine.skipped", "occurrence.due" — only sleep got the first-class event-trigger treatment, presumably because that's the scenario that needed it.

**Confidence:** the larp inventory is **high confidence** (filenames, string literals, hardcoded enums are literally there). The recommended decompositions are **mostly high confidence** for items 1–3 above (clear case for registries / removal); **medium confidence** for the umbrella-action decomposition (some bundling is genuinely needed for UX/transactional reasons — see Section 7). The PII rename plan is **high confidence** but ordering matters (Section 9) so test imports don't break.

Overall verdict: the code is closer to *working AI-shaped slop* than to a clean primitive engine. The framework primitives are correct; the scenario sediment on top needs to be peeled off and replaced with registries.

---

## Section 2 — Inventory by Category

### Category 1 — Scenario-named source code

| Path | Evidence | Category |
|---|---|---|
| `src/lifeops/seed-routines.ts` | `key: "brush_teeth" / "invisalign" / "drink_water" / "stretch" / "vitamins" / "workout" / "shower" / "shave"` — 8 scenario constants in source | scenario |
| `src/lifeops/stretch-decider.ts` | Whole 144-line module dedicated to stretch-specific cooldown, weekend skip, late-evening cutoff, walk-out reset, copy variants | scenario |
| `src/lifeops/seed-routines.ts:21` | `export const STRETCH_ROUTINE_TITLE = "Stretch"` — string literal exported so the reminder dispatch loop can grep-match it | scenario + larp coupling |
| `src/lifeops/service-mixin-reminders.ts:567-572` | `function isStretchDefinition(definition)` checks `definition?.title === STRETCH_ROUTINE_TITLE` — title-string equality inside the reminder dispatcher | scenario carve-out |
| `src/lifeops/service-mixin-reminders.ts:582-606` | `evaluateStretchReminderGate` and `STRETCH_REMINDER_VARIANTS` rotation — entire gate dedicated to one routine | scenario carve-out |
| `src/activity-profile/proactive-worker.ts:581-585` | Hardcoded `SEEDING_MESSAGE` enumerating "brush teeth, drink water, stretch breaks, vitamins, workout, shower, and shave" in agent copy | scenario + LARP |
| `src/lifeops/service-mixin-definitions.ts:75,247-271,287-348` | `checkAndOfferSeeding` / `applySeedRoutines` API methods built around the scenario-named templates | scenario API surface |
| `src/api/client-lifeops.ts:151` | API client imports `RoutineSeedTemplate` — leaks scenario abstraction to client | scenario |
| `src/routes/lifeops-routes.ts:3003` | Route exposes `checkAndOfferSeeding` over HTTP | scenario |

### Category 2 — PII / fictional identities

In source code (not just fixtures):

| Path | Evidence |
|---|---|
| `src/actions/calendar.ts:669` | Action `tags: [..., "daily time with Jill", ...]` (planner-visible) |
| `src/actions/calendar.ts:1081-1087` | Inline ActionExample with prompt `"Need to book 1 hour per day for time with Jill"` and reply `"I'll set up a recurring daily one-hour block with Jill ..."` |
| `src/actions/calendar.ts:1027` | ActionExample `"Propose three 30-minute slots for a sync with Marco next week."` |
| `src/actions/lib/calendar-handler.ts:4227-4233` | Same Jill example, duplicated |
| `src/actions/lib/scheduling-handler.ts:469` | Action description literal: `"... 'suggest a few times for Jill', 'offer Marco three 30-minute slots', 'find us three options ... 'give me slots to send Sarah'."` |
| `src/actions/resolve-request.ts:489` | ActionExample `"Yeah, go ahead and send that draft to Marco."` |
| `src/actions/life.ts:3509-3517` | ActionExample with literal Spanish text `"recuérdame cepillarme los dientes por la mañana y por la noche"` and Spanish reply `"Puedo guardar el hábito \"Brush teeth\"..."` |

In fixtures (acceptable in tests, but worth a generic rename):

| Path | Evidence |
|---|---|
| `test/scenarios/_catalogs/ice-bambam-executive-assistant.json` | `catalogId: "ice-bambam-executive-assistant"`, references `"ice bambam 🧊🍣"` Discord transcript path |
| `test/mocks/environments/lifeops-samantha.json` | Mock env named after a fictional persona; routes like `__mock/lifeops/samantha/scenarios` |
| `scenarios/gmail-suran-routing.json` + `test/scenarios/gmail-suran-routing.scenario.ts` | Scenario id and title use fictional name "Suran" |
| `test/lifeops-chat.live.e2e.test.ts:811-830` | Test cases with `"find the email from suran"` etc. |
| `test/lifeops-gmail-chat.live.e2e.test.ts:173-178` | Synthetic email "from Suran Lee \<suran@example.com\>" baked into test data |
| `test/scenarios/_catalogs/ice-bambam-executive-assistant.json` | Source: `"/Users/shawwalters/Desktop/chat-exports/discord/Direct Messages - ice bambam 🧊🍣 [...].json"` — references a private chat export path |
| `test/scenarios/_catalogs/ice-bambam-executive-assistant.json:24` | `"id": "ea.schedule.daily-time-with-jill"` (and ~30 more `ea.*` ids referencing Jill) |
| `coverage-matrix.md:13` | First row: `Recurring Relationship Time (e.g. weekly Jill block)` — contract test enforces 20 named PRD journeys |
| `test/helpers/lifeops-prompt-benchmark-cases.ts:41,56,138` | `SELF_CARE_PRD_SCENARIO_IDS` enumerates `workout-blocker-basic`, `invisalign-weekday-lunch`, etc.; references the ice-bambam catalog |

### Category 3 — Hardcoded compound actions

| Action | Subactions | Verdict |
|---|---|---|
| `CALENDAR` (`src/actions/calendar.ts`) | 24 subactions: `feed`, `next_event`, `search_events`, `create_event`, `update_event`, `delete_event`, `trip_window`, `bulk_reschedule`, `check_availability`, `propose_times`, `update_preferences`, 4× `calendly_*`, 7× `negotiate_*` | Mega-umbrella. Calendly + Google Calendar + scheduling negotiation collapsed into one action. **Decompose:** Calendly is its own connector; negotiation is a long-running stateful workflow; bulk_reschedule should be a transactional compound. |
| `LIFE` (`src/actions/life.ts`) | 7 verbs × 2 kinds (`definition`/`goal`) | OK as a CRUD-on-definitions umbrella, but `kind` should be a registered handler (`registerLifeKind("definition", ...)`, `registerLifeKind("goal", ...)`) instead of an internal switch. |
| `CONNECTOR` (`src/actions/connector.ts`) | 5 subactions × 9 hardcoded connector kinds in `CONNECTOR_DISPATCHERS` | Hardcoded `Record<ConnectorKind, ConnectorDispatcher>` map. Should be a registry — every connector self-registers a dispatcher. |
| `RELATIONSHIP` | 8 similes; subactions list `list_contacts add_contact log_interaction add_follow_up complete_follow_up follow_up_list days_since list_overdue_followups mark_followup_done set_followup_threshold` | Two distinct concerns conflated: contacts CRUD vs follow-up tracker. Plus 3 separate first-class actions exist (`listOverdueFollowupsAction`, `markFollowupDoneAction`, `setFollowupThresholdAction`) — collision between primitives and umbrella. |
| `PROFILE` | `save / set / capture_phone / set_reminder_preference / configure_escalation` | `save` and `set` are pure aliases of each other ("Compatibility alias" — `profile.ts:90-91`). `set_reminder_preference` and `configure_escalation` are not profile concerns; they belong on a `REMINDER_POLICY` action. |
| `VOICE_CALL` | `place / call_owner / call_external` | `call_owner` vs `call_external` is a *target type* parameter, not three actions. Genuine compound is the call+approval flow (Section 7). |
| `BOOK_TRAVEL` | One action that searches → drafts → queues approval → calendar-syncs | **Legitimate compound** (Section 7) — must remain transactional. |

### Category 4 — Misplaced actions / sub-actions

| Path | Issue |
|---|---|
| `src/actions/checkin.ts` | `CHECKIN` action exists (148 lines, registered in `plugin.ts:254`), but the sibling file `src/actions/CHECKIN_MIGRATION.TODO.md` says the action *was* removed and the briefing should run as a scheduled task. The action was reintroduced or the TODO is stale — either way it's now misclassified: a daily briefing isn't a planner-visible verb, it's a cron job. |
| `src/actions/scheduled-trigger-task.ts` | Not an `Action` at all — it's a helper called `scheduleOnceTriggerTask`. Misnamed file (no action exported). |
| `src/actions/non-actionable-request.ts` | Not an action — a single predicate `looksLikeCodingTaskRequest`. Belongs in a validation helper module. |
| `src/actions/extractor-pipeline.ts` | Not an action — a generic LLM call orchestrator. Belongs in `src/lifeops/llm/` or `src/utils/`. |
| `src/actions/timezone-normalization.ts` | Not an action — a TZ alias map + parser. Belongs in `src/lifeops/time.ts` or a TZ utility module. |
| `src/actions/lifeops-extraction-config.ts` | Not an action — one env-var reader. Belongs in `src/lifeops/defaults.ts`. |
| `src/actions/lifeops-google-helpers.ts` | Not an action — 958 lines of helpers (LLM calls, format helpers, hasLifeOpsAccess, INTERNAL_URL constant). Belongs in `src/lifeops/google/` or split into util modules. The **action file directory should contain only Action exports.** |
| `src/actions/lifeops-grounded-reply.ts` | Helper wrapping `renderGroundedActionReply`. Belongs in `src/lifeops/llm/` or `src/lifeops/voice/`. |
| `src/actions/gmail.ts` | Exports `extractGmailPlanWithLlm` — a helper, not an action. The actual gmail surface lives inside `CALENDAR`/`MESSAGE` triage. Misnamed. |
| `src/actions/lib/scheduling-handler.ts` | A 469+-line "handler" file that defines a sub-action called `proposeMeetingTimesAction` registered as a `subAction` of `CALENDAR` (`calendar.ts:699`). Sub-action pattern is OK; the location is misleading (not in `actions/`). |
| `src/followup/actions/listOverdueFollowupsAction` etc. | These three first-class actions duplicate functionality already inside `RELATIONSHIP.list_overdue_followups`/`mark_followup_done`/`set_followup_threshold`. Pick one path. |
| Inbox triage actions imported from `messagingTriageActions` (`plugin.ts:272`) | These are core actions injected from elsewhere, not LifeOps actions. The mix of "ours + theirs" in the registration array hides the actual LifeOps surface. |

### Category 5 — Test-shaped / scenario-coupled code

| Path | Evidence |
|---|---|
| `src/lifeops/service-mixin-reminders.ts:567-606` | `isStretchDefinition` + `evaluateStretchReminderGate` only fire for `title === "Stretch"`. Production code branches on a seeded title-string. |
| `src/lifeops/seed-routines.ts:21,87,92` | `STRETCH_ROUTINE_TITLE` constant is exported solely so the reminder dispatcher can string-match against the seed. |
| `src/lifeops/stretch-decider.ts` | Entire module — its public function `shouldStretchNow` and `pickStretchReminderCopy` only ever fire from the stretch gate. Effectively single-call-site code. |
| `coverage-matrix.md` + `test/prd-coverage.contract.test.ts:156-164` | Contract test asserts exactly **20 PRD journey rows** with named scenarios like "Recurring Relationship Time (e.g. weekly Jill block)", "Speaker Portal Upload Via Browser Automation". The matrix encodes product-shape into a test contract — meaning the test fights any decomposition that changes the journey count. |
| `test/scenarios/_catalogs/ice-bambam-executive-assistant.json` | `catalogId` ties test fixtures to one specific transcript export. Filename is the smell. |
| `test/helpers/lifeops-prompt-benchmark-cases.ts:41-65` | Hardcoded `SELF_CARE_PRD_SCENARIO_IDS` and `SELF_CARE_HABIT_SCENARIO_IDS` arrays — adding/removing a scenario file means editing this list. |
| `src/actions/life.ts:3509-3517` | One Spanish ActionExample for brush-teeth — exists to back the `brush-teeth-spanish` scenario. Multilingual is hardcoded one phrase at a time. |
| `src/actions/calendar.ts` `tags` array (`.ts:663-684`) | 18 hardcoded "always-include" planner trigger phrases like "daily time with Jill", "flight conflict", "rebook the other thing" — these are *scenario rehearsals* baked into the action metadata. |

### Category 6 — LARP / placeholder / stub

| Path | Evidence |
|---|---|
| `packages/shared/src/contracts/lifeops-extensions.ts:1-5` | Header comment: `"Extensions added by Wave 1+ for new LifeOps features (relationships, X read, ...). These were supposed to be appended to ./lifeops.ts by Wave 0 but the agent reported done without actually writing them."` Self-acknowledged AI agent failure mode preserved as a side-file. |
| `src/lifeops/messaging/index.ts:6-12` | `W15 INTEGRATION NOTES:` block — "Register XDmAdapter, CalendlyAdapter, BrowserBridgeAdapter via the triage service's adapter registry (find the registration pattern in @elizaos/core/...). Remove any imports of the deleted action files from plugin.ts/index.ts." Inline TODOs in a public module. |
| `src/actions/CHECKIN_MIGRATION.TODO.md` | A `.md` file inside the `actions/` directory describing a migration that was never finished — and `checkin.ts` is still registered. |
| `src/lifeops/service.ts:71-78` | `// TypeScript loses track of constraint satisfaction past ~6 chained generic mixins, so we cast explicitly.` Service god-class composes 30+ mixins and casts past the type system. |
| `src/lifeops/service.ts:92-103` | `/** Declared explicitly: mixin composition exceeds TypeScript inference depth. */ export interface LifeOpsService { processScheduledWork(...): Promise<...>; }` — separate interface declaration to backfill type info the composition lost. |
| `src/actions/voice-call.ts:929` and `src/actions/autofill.ts:528` | `export const __internal = { ... }` — leaking internals "for tests" with leading double-underscore. |
| `src/actions/life.ts:3579 lines` | One file is 3579 lines. That's a smell on its own — `life.ts` should be a handful of orchestration calls, not a runtime. |

### Category 7 — Service-registry candidates (hardcoded enums/switches that should be registries)

| Path | Hardcoded thing | Registry it should become |
|---|---|---|
| `src/actions/connector.ts:18-36, 1294-1304` | `VALID_CONNECTORS` / `CONNECTOR_DISPATCHERS` map | `ConnectorRegistry.register({ kind, dispatcher, capabilities, scopes })` — every connector plugin self-registers; the action iterates the registry. |
| `src/lifeops/seed-routines.ts:36-165` | `ROUTINE_SEED_TEMPLATES` array of 8 seed templates | `RoutineTemplateRegistry` — first-party seeds are *one* contributor; user customization, packs, and Cloud-distributed bundles register the same way. The templates themselves are *data*, fine to keep, but the *list* must not be a closed array. |
| `src/lifeops/stretch-decider.ts` + `service-mixin-reminders.ts:567-606` | One-off stretch gate | `ReminderGateRegistry` — definitions register a `gateKey` in metadata; the reminder dispatcher looks the gate up by key, not by string-matching titles. Stretch becomes one of many possible gates contributed by templates or workflows. |
| `packages/shared/src/contracts/lifeops.ts:90-102` (`LIFEOPS_EVENT_KINDS`) | 11 hardcoded event kinds, 8 of which are sleep-specific | `EventKindRegistry` — event kinds are namespace-prefixed strings; detectors register their kinds at startup. Mixing `calendar.event.ended` (primitive) with `lifeops.bedtime.imminent` (sleep-only) inside the same union is the smell. |
| `LIFEOPS_REMINDER_CHANNELS`, `LIFEOPS_CHANNEL_TYPES`, `LIFEOPS_MESSAGE_CHANNELS` | 3 overlapping channel enums | `ChannelRegistry` — every channel has `{kind, supportsRead, supportsSend, supportsAttachments, owner, agent}` capabilities. The 3 enums diverge (e.g. `browser` is in CHANNEL_TYPES but not REMINDER_CHANNELS) because they're hand-maintained. |
| `LIFEOPS_GOOGLE_CAPABILITIES`, `LIFEOPS_X_CAPABILITIES`, `LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES`, `LIFEOPS_SIGNAL_CAPABILITIES`, `LIFEOPS_DISCORD_CAPABILITIES`, `LIFEOPS_TELEGRAM_CAPABILITIES` | 6 per-provider hardcoded capability lists | A single typed capability descriptor + per-connector capability sets carried alongside the registration. |
| `src/lifeops/feature-flags.types.ts:33-43, 71-143` | `LifeOpsFeatureKey` literal union (10 keys) + `BASE_FEATURE_DEFAULTS` `Readonly<Record<...>>` | `FeatureFlagRegistry` — every feature self-registers `{ key, label, description, costsMoney, defaultEnabled, cloudDefaultOn }`. Currently if an app/plugin wants a new toggle it has to edit the LifeOps types file. |
| `src/lifeops/autofill-whitelist.ts:7-55` | `DEFAULT_AUTOFILL_WHITELIST` of 49 specific brand domains (github.com, stripe.com, …) | A category-tagged registry; the user's domain list is the source of truth; defaults can be a contributed pack. |
| `src/actions/calendar.ts:228-339` | `OWNER_CALENDAR_SUBACTION_SPECS` lists 24 subactions including 4 calendly_*, 7 negotiate_* | Calendly should be its own registered scheduling provider; negotiation should be a workflow with subactions registered through the workflow contract. |
| `LIFEOPS_AUDIT_EVENT_TYPES` (`lifeops.ts:507-543`) | 33 hardcoded audit event types | `AuditTypeRegistry` — event-emitting subsystems register their types. |
| `LIFEOPS_TELEMETRY_FAMILIES` (`lifeops.ts:1513-1525`) | 11 hardcoded payload families with full discriminated union | Mostly OK as a closed enum (telemetry shapes shouldn't change every day), but the discriminator mixes `device_presence_event`, `screen_time_summary`, `manual_override_event` — different concerns that probably belong in separate registries. |
| `LIFEOPS_OWNER_TYPES` (`lifeops.ts:493-505`) | 10 hardcoded "owner types" for audit/policy lookup | Each subsystem should register its owner type. Currently `circadian_state` and `browser_session` are baked in here. |

### Category 8 — Compound vs decompose call-out (preview; full list in §7)

Genuine compound (keep transactional): `BOOK_TRAVEL` (search→draft→approval→pay→calendar), `RELEASE_BLOCK` (verify state + clear + audit), `OWNER_SEND_APPROVAL` flow inside `owner-send-policy.ts`, the `negotiate_*` lifecycle (must be one stateful negotiation actor). Decompose: `CHECKIN` (cron job, not action), `RELATIONSHIP` (split contacts vs follow-ups), `PROFILE` (split owner-fact vs reminder-policy), `CONNECTOR` (per-connector via registry), `CALENDAR` (split google+calendly+negotiation).

### Category 9 — Hardcoded vocabulary / event-kind sprawl

`LIFEOPS_EVENT_KINDS` (`lifeops.ts:90-102`):

| Kind | Verdict |
|---|---|
| `calendar.event.ended` | primitive ✅ |
| `gmail.message.received` | primitive ✅ |
| `gmail.thread.needs_response` | primitive ✅ |
| `lifeops.sleep.onset_candidate` | scenario (sleep) |
| `lifeops.sleep.detected` | scenario (sleep) |
| `lifeops.sleep.ended` | scenario (sleep) |
| `lifeops.wake.observed` | scenario (sleep) |
| `lifeops.wake.confirmed` | scenario (sleep) |
| `lifeops.nap.detected` | scenario (sleep) |
| `lifeops.bedtime.imminent` | scenario (sleep) |
| `lifeops.regularity.changed` | scenario (sleep) |

Plus the workflow schedule kinds (`during_morning`, `during_night`, `relative_to_wake`, `relative_to_bedtime`) hardwire the *sleep cycle as a first-class scheduling primitive*. That works for one user, but encodes "sleep" as a domain-level abstraction rather than a contributor-registered "anchor". Generic alternative: `relative_to_anchor(anchorKey, offsetMinutes)` where `anchorKey` is registered (`wake.confirmed`, `bedtime.target`, `lunch.start`, `meeting.ended`, …).

Other vocabulary smells:
- `LifeOpsScheduleMealLabel = "breakfast" | "lunch" | "dinner"` (`lifeops.ts:1753`) — closed meal vocabulary excludes brunch, second lunch, midnight snack, fasting overrides. Use `mealLabel: string` with a registered enum for the planner.
- `LifeOpsSleepCycleEvidenceSource = "health" | "activity_gap"` — fine for now but should accept registered sources.
- `LifeOpsMobileDeviceTelemetrySource`, `LifeOpsHealthSignalSource` etc. — provider-coupled enums.

### Category 10 — Connector hardcoding

| Path | Evidence |
|---|---|
| `src/actions/connector.ts:18-28` | 9 connector kinds hardcoded in `VALID_CONNECTORS` |
| `src/actions/connector.ts:105-114` | `MESSAGE_CONNECTOR_SOURCE_BY_LIFEOPS_CONNECTOR` partial-record map of LifeOps→core MessageSource |
| `src/actions/connector.ts:1294-1304` | `CONNECTOR_DISPATCHERS satisfies Record<ConnectorKind, ConnectorDispatcher>` — adding a connector requires editing this file |
| `src/lifeops/service.ts:53-82` | Service composition explicitly chains `withGoogle`, `withGmail`, `withCalendar`, `withDrive`, `withX`, `withTelegram`, `withDiscord`, `withSignal`, `withWhatsApp`, `withIMessage`, `withTwilio` (via twilio.ts), `withTravel` (Duffel-coupled) — connector logic is part of the service, not registered. |
| `src/lifeops/messaging/owner-send-policy.ts:3-4` | `OWNER_APPROVAL_REQUIRED = new Set<MessageSource>(["gmail"])` — the *one* connector that requires approval is hardcoded |
| `src/lifeops/messaging/adapters/*.ts` | 4 hardcoded adapters (Gmail, X DM, Calendly, BrowserBridge) registered in `plugin.ts:316-319` via direct imports |
| `LIFEOPS_X_FEED_TYPES`, `LIFEOPS_X_CAPABILITIES`, `LifeOpsXDm`, `LifeOpsXFeedItem` | X is given first-class typed surface — DMs, feed items, sync state — none of which are abstracted as "social feed" or "DM connector" interfaces |
| `LifeOpsIMessageConnectorStatus`, `LifeOpsIMessageHostPlatform`, etc. | iMessage gets its own typed contract block instead of being a generic "messaging connector with platform-specific status" |
| `src/lifeops/twilio.ts` | Twilio is a literal module, not a registered SMS/voice provider |

---

## Section 3 — PII and Scenario-Name Register

**In source code (must rename — these ship to the planner):**

| Current location | Current value | Generalize to |
|---|---|---|
| `src/actions/calendar.ts:669` (in `tags`) | `"daily time with Jill"` | Drop — tag should be `"recurring partner block"` or `"recurring relationship block"` (or remove; example-by-tag is questionable) |
| `src/actions/calendar.ts:1027,1081-1087` (ActionExamples) | `"sync with Marco"`, `"time with Jill"` | `"sync with a colleague"`, `"recurring 1:1 with my partner"` |
| `src/actions/lib/calendar-handler.ts:4227-4233` | Same Jill example | Same generic |
| `src/actions/lib/scheduling-handler.ts:469-470` | `"suggest a few times for Jill", "offer Marco three 30-minute slots", "give me slots to send Sarah"` | `"suggest times for a 1:1", "offer three 30-minute slots", "give me slots to send"` |
| `src/actions/resolve-request.ts:489` | `"send that draft to Marco"` | `"send that draft"` |
| `src/actions/life.ts:3509,3515` | Spanish brush-teeth example with literal `"Brush teeth"` | Either keep generic (`"recordar habit X mañana y noche"`) or move multilingual examples to a translation table contributed at boot time, not source |

**In fixtures (rename for hygiene; make sure no test imports them by literal path):**

| Current | Suggested |
|---|---|
| `test/scenarios/_catalogs/ice-bambam-executive-assistant.json` | `test/scenarios/_catalogs/executive-assistant-transcript.catalog.json` |
| `test/mocks/environments/lifeops-samantha.json` | `test/mocks/environments/lifeops-presence-active.json` (or similar — content describes presence + tasks endpoints) |
| `test/mocks/environments/lifeops-presence.json` | already neutral — keep |
| `scenarios/gmail-suran-routing.json` | `scenarios/gmail-direct-message-sender-routing.json` |
| `test/scenarios/gmail-suran-routing.scenario.ts` | match the rename |
| Inside `ice-bambam-executive-assistant.json`: `ea.schedule.daily-time-with-jill` etc. | `ea.schedule.recurring-relationship-block` |
| Inside `lifeops-chat.live.e2e.test.ts` and `lifeops-gmail-chat.live.e2e.test.ts`: `Suran Lee`, `suran@example.com` | `Pat Smith` / `pat@example.com` (generic) — also remove the absolute path reference `"/Users/shawwalters/Desktop/chat-exports/discord/Direct Messages - ice bambam 🧊🍣 [...].json"` from the catalog metadata |
| `coverage-matrix.md:13` | `Recurring Relationship Time (e.g. weekly Jill block)` → `Recurring Relationship Time` (drop the parenthetical example) |
| `test/helpers/lifeops-prompt-benchmark-cases.ts:138` | `"ice-bambam-executive-assistant.json"` → match catalog rename |

The chat-export path `/Users/shawwalters/Desktop/chat-exports/discord/Direct Messages - ice bambam 🧊🍣 [1323980531141972083].json` inside `ice-bambam-executive-assistant.json:5` is also a privacy concern — that's a real Discord conversation ID + a real contact's display name shipped in a public catalog file.

---

## Section 4 — Action-by-Action Classification

| File | Action name | What it does | Verdict | Recommended location | Recommended decomposition |
|---|---|---|---|---|---|
| `actions/app-block.ts` (608L) | `APP_BLOCK` | block/unblock/status mobile apps via Family Controls (iOS) / Usage Access (Android) | primitive (3 verbs, single domain) | keep as action | OK as-is. Status could be a provider, not a subaction. |
| `actions/autofill.ts` (533L) | `AUTOFILL` | fill / whitelist_add / whitelist_list | primitive (3 verbs) | keep as action | The hardcoded `DEFAULT_AUTOFILL_WHITELIST` (49 brand domains) should be configurable, not a source-code constant. |
| `actions/book-travel.ts` (750L) | `BOOK_TRAVEL` | Single-shot search→draft→approval queue→book→calendar-sync | **legitimate compound** | keep | Stay compound (Section 7); the connector should be a registered travel provider (Duffel is the only one wired). |
| `actions/calendar.ts` (1134L) + `lib/calendar-handler.ts` + `lib/calendly-handler.ts` + `lib/scheduling-handler.ts` | `CALENDAR` umbrella + `googleCalendarAction`, `proposeMeetingTimesAction`, `checkAvailabilityAction`, `updateMeetingPreferencesAction`, `calendlyAction`, `schedulingAction` sub-actions | 24 subactions across Google Calendar, Calendly, availability, preferences, scheduling negotiation | scenario-named in tags+examples; compound | keep `CALENDAR` umbrella name | **Decompose:** Calendly should be a separately-registered scheduling provider; `negotiate_*` should be a workflow lifecycle action (long-running, not a verb); `bulk_reschedule` is a legitimate compound. Strip the named-person tags. |
| `actions/checkin.ts` (147L) | `CHECKIN` | Run morning/night briefing now | misplaced | should not be an action | The TODO file in the same directory says this was supposed to be a scheduled task, not a planner verb. Move logic to a cron task; remove the action. The service (`CheckinService`) is fine. |
| `actions/connector.ts` (1570L) | `CONNECTOR` | connect/disconnect/verify/status/list across 9 hardcoded connector kinds | scenario-named (per-connector dispatchers) | keep umbrella | **Decompose via registry** — `CONNECTOR_DISPATCHERS` becomes a `ConnectorRegistry`. |
| `actions/device-intent.ts` (199L) | `DEVICE_INTENT` | broadcast a notification across owner devices | primitive | keep | OK. Subaction is just `broadcast` (1 of 1 — collapse). |
| `actions/extractor-pipeline.ts` (113L) | (no action exported) | LLM call→parse→repair→parse helper | misplaced (not an action) | move to `src/lifeops/llm/extractor-pipeline.ts` | Move out of `actions/`. |
| `actions/gmail.ts` (76L) | (no action exported) | `extractGmailPlanWithLlm` helper | misplaced (not an action) | move to `src/lifeops/llm/extract-gmail-plan.ts` | Move out of `actions/`. |
| `actions/health.ts` (717L) | `HEALTH` | today / trend / by_metric / status — query health connector data | primitive | keep | Subactions are CQRS-clean reads. The hardcoded `HEALTH_METRICS` array (`steps, heart_rate, sleep_hours, calories, distance_meters, active_minutes`) is a subset of the contract's `LIFEOPS_HEALTH_METRICS` (17 entries) — fix the inconsistency. |
| `actions/life.ts` (3579L) | `LIFE` | CRUD on definitions/goals + occurrence verbs | primitive at the verb level; oversized at the file level | keep | Split the 3579-line file: handlers per verb, deferred-draft logic in its own module, examples block extracted, kind-handler should be a registry. |
| `actions/lifeops-extraction-config.ts` (27L) | (no action) | env var reader | misplaced | move to `src/lifeops/defaults.ts` | Move. |
| `actions/lifeops-google-helpers.ts` (958L) | (no action — exports `INTERNAL_URL`, `hasLifeOpsAccess`, formatters) | helpers for google-coupled actions | misplaced (not an action) | split: `src/lifeops/access.ts`, `src/lifeops/format/email.ts`, etc. | Move out of `actions/`. |
| `actions/lifeops-grounded-reply.ts` (63L) | (no action — exports `renderLifeOpsActionReply`) | grounded-reply wrapper | misplaced | move to `src/lifeops/voice/grounded-reply.ts` | Move. |
| `actions/non-actionable-request.ts` (29L) | (no action — exports `looksLikeCodingTaskRequest`) | predicate | misplaced | move to `src/lifeops/validate/` | Move. |
| `actions/password-manager.ts` (307L) | `PASSWORD_MANAGER` | search / list / inject_username / inject_password | primitive | keep | The 1Password env-var reading is fine; coupling to 1Password specifically should become a password-manager-bridge registry. |
| `actions/payments.ts` (415L) | `PAYMENTS` | dashboard / list_sources / add_source / remove_source / import_csv / list_transactions / spending_summary / recurring_charges | primitive (CRUD on a domain) | keep | OK. Plaid/PayPal integration is hidden; should be a payment-source registry. |
| `actions/profile.ts` (661L) | `PROFILE` | save / set / capture_phone / set_reminder_preference / configure_escalation | misplaced | split | `save`/`set` are aliases — collapse. `capture_phone` is owner-fact CRUD. `set_reminder_preference` and `configure_escalation` belong on a `REMINDER_POLICY` action, not on profile. |
| `actions/relationship.ts` (1193L) | `RELATIONSHIP` | contacts CRUD + interaction log + follow-up tracker | misplaced bundle | split | Split into `CONTACTS` (people graph) and `FOLLOW_UPS` (cadence tracker). The 3 standalone follow-up actions (`listOverdueFollowupsAction`, `markFollowupDoneAction`, `setFollowupThresholdAction`) are evidence of the split already in flight — finish it. |
| `actions/remote-desktop.ts` (460L) | `REMOTE_DESKTOP` | start/status/end/list/revoke | primitive | keep | OK. |
| `actions/resolve-request.ts` (514L) | `RESOLVE_REQUEST` | approve/reject queued action | primitive | keep | Genuine 2-verb compound. The dispatch into `executeApprovedBookTravel` etc. should be via a `ResolverRegistry` instead of an import switch. |
| `actions/schedule.ts` (229L) | `SCHEDULE` | summary/inspect circadian schedule inference | primitive | keep | The whole "schedule" surface is sleep-coupled — see Section 7 for whether passive-schedule inference should remain a single action. |
| `actions/scheduled-trigger-task.ts` (131L) | (no action — exports `scheduleOnceTriggerTask`) | helper | misplaced | move to `src/lifeops/triggers/` | Move. |
| `actions/screen-time.ts` (785L) | `SCREEN_TIME` | summary/today/weekly/weekly_average_by_app/by_app/by_website/activity_report/time_on_app/time_on_site/browser_activity | primitive (10 reads) | keep | Genuine read CQRS surface. Source coupling (`macOS native activity tracker`, `browser extension`) should be source registry, not subaction. |
| `actions/subscriptions.ts` (572L) | `SUBSCRIPTIONS` | audit/cancel/status | primitive | keep | OK. |
| `actions/timezone-normalization.ts` (185L) | (no action — TZ alias map + parser) | helper | misplaced | move to `src/lifeops/time/timezone.ts` | Move. |
| `actions/toggle-feature.ts` (281L) | `TOGGLE_FEATURE` | enable/disable a feature flag | primitive | keep | The feature-key set is a closed enum (`LifeOpsFeatureKey`); should be a registry (Section 5). |
| `actions/voice-call.ts` (932L) | `VOICE_CALL` | place/call_owner/call_external | primitive verbs but Twilio-coupled | keep | The three subactions are *recipient categories*; could be one verb with `recipient: owner | external | number`. Twilio coupling: use a registered voice-call provider. |
| `actions/website-block.ts` (952L) | `WEBSITE_BLOCK` | block/unblock/status/request_permission | primitive | keep | OK. |
| `website-blocker/chat-integration/actions/listActiveBlocks.ts` | `LIST_ACTIVE_BLOCKS` | list active rules | primitive | OK | These three duplicate `WEBSITE_BLOCK.status`-style functionality. Decide: one umbrella OR three primitives. Currently both. |
| `website-blocker/chat-integration/actions/releaseBlock.ts` | `RELEASE_BLOCK` | release a specific block rule | primitive | OK | Same — collision with `WEBSITE_BLOCK.unblock`. |
| `followup/actions/listOverdueFollowups.ts` | `LIST_OVERDUE_FOLLOWUPS` | list overdue follow-ups | primitive | OK | Collision with `RELATIONSHIP.list_overdue_followups`. |
| `followup/actions/markFollowupDone.ts` | `MARK_FOLLOWUP_DONE` | mark follow-up complete | primitive | OK | Collision with `RELATIONSHIP.mark_followup_done`. |
| `followup/actions/setFollowupThreshold.ts` | `SET_FOLLOWUP_THRESHOLD` | configure overdue threshold | primitive | OK | Collision with `RELATIONSHIP.set_followup_threshold`. |
| `messagingTriageActions` (from `@elizaos/core`) | (multiple) | core-injected triage actions | external | keep | Not LifeOps-owned. |

**Summary:** of 28 files in `actions/`, **9 are not actions** (helpers, configs, predicates) and should move out. **3 collisions** between umbrella subactions and standalone actions exist (website-blocker × WEBSITE_BLOCK, follow-up trio × RELATIONSHIP). **CHECKIN** should be a scheduled task per its own TODO file.

---

## Section 5 — Service-Registry Refactoring Opportunities

For each opportunity below: `Sketch` shows the registration shape. `Existing code that would migrate` lists the files that today inline what the registry would replace.

### 5.1 Connector registry

```ts
interface ConnectorContribution {
  kind: string;                    // "google" | "x" | …; not a closed union
  capabilities: ReadonlyArray<string>;
  side: "owner" | "agent";
  describe(): { label: string; modes: ConnectorMode[] };
  connect(ctx, params): Promise<ActionResult>;
  disconnect(ctx, params): Promise<ActionResult>;
  verify(ctx, params): Promise<ActionResult>;
  status(ctx): Promise<ConnectorStatus>;
}
ConnectorRegistry.register(googleConnector);
ConnectorRegistry.register(xConnector);
// …
```
Migrate from: `actions/connector.ts:18-36, 105-114, 1294-1304`; `LIFEOPS_CONNECTOR_PROVIDERS`; per-provider capability enums; `service-mixin-{google,x,telegram,signal,discord,whatsapp,imessage}.ts` (status/connect surface only).

### 5.2 Routine-template registry

```ts
interface RoutineTemplateContribution {
  key: string; title: string; description: string;
  category: string;                // not a closed union
  request: Pick<CreateLifeOpsDefinitionRequest, ...>;
  isAvailableFor?(profile: OwnerProfile): boolean;  // optional
}
RoutineTemplateRegistry.register({ key: "brush_teeth", … });
```
Migrate from: `src/lifeops/seed-routines.ts` (all 8 templates become contributions in a default-pack module that the plugin registers), `service-mixin-definitions.ts:75,247-348`. **Stretch-decider** disappears entirely; instead the brush-teeth/stretch/etc. template metadata declares `gateKey` if it needs special handling, and `ReminderGateRegistry` takes over.

### 5.3 Reminder-gate registry

```ts
interface ReminderGate {
  key: string;
  shouldFire(ctx: ReminderGateContext): GateDecision;
}
ReminderGateRegistry.register(stretchGate);
ReminderGateRegistry.register(busyDayGate);
```
Migrate from: `service-mixin-reminders.ts:567-606` (`isStretchDefinition`, `evaluateStretchReminderGate`); `stretch-decider.ts` becomes one registered gate, not 144 lines next to the dispatcher.

### 5.4 Event-kind / anchor registry

```ts
interface EventKindContribution {
  kind: string;                    // namespace-prefixed; no closed union
  filterSchema?: ZodSchema;
  detect(ctx: DetectorContext): Iterable<DetectedEvent>;
}
interface AnchorContribution {
  key: string;                     // "wake.confirmed", "bedtime.target", "lunch.start"
  resolve(ctx: AnchorContext): { atIso: string; confidence: number } | null;
}
```
Migrate from: `LIFEOPS_EVENT_KINDS` (`lifeops.ts:90-102`) — the 8 sleep events and the regularity event become detector contributions; the workflow schedule kinds `relative_to_wake` / `relative_to_bedtime` / `during_morning` / `during_night` collapse into `relative_to_anchor` + `during_window` with anchor keys.

### 5.5 Channel registry

```ts
interface ChannelContribution {
  kind: string;
  supports: { read: boolean; send: boolean; reminders: boolean; voice: boolean; };
  ownerSide: ChannelSurface; agentSide: ChannelSurface;
}
```
Migrate from: `LIFEOPS_REMINDER_CHANNELS`, `LIFEOPS_CHANNEL_TYPES`, `LIFEOPS_MESSAGE_CHANNELS`, `LIFEOPS_TELEMETRY_MESSAGE_CHANNEL` — the four overlapping enums collapse into one registry. Per-connector adapter (`gmail-adapter.ts`, `x-dm-adapter.ts`, `calendly-adapter.ts`, `browser-bridge-adapter.ts`) self-registers its channel.

### 5.6 Feature-flag registry

```ts
FeatureFlagRegistry.register({
  key: "travel.book_flight", label: …, description: …,
  costsMoney: true, defaultEnabled: false, cloudDefaultOn: true,
});
```
Migrate from: `src/lifeops/feature-flags.types.ts:33-43, 71-143, 151-157`. Every action that gates on a feature would call `FeatureFlagRegistry.requireEnabled(runtime, key)` against the registered key. Currently editing the closed `LifeOpsFeatureKey` union is required to add a feature.

### 5.7 Reminder-policy / send-policy registry

```ts
interface SendPolicyContribution {
  source: string;
  shouldRequireApproval(draft): Promise<boolean>;
}
```
Migrate from: `src/lifeops/messaging/owner-send-policy.ts:3-4` (`OWNER_APPROVAL_REQUIRED = new Set(["gmail"])`). Each connector contributes its own policy.

### 5.8 Approval-resolver registry

Migrate from: `src/actions/resolve-request.ts` (the `RESOLVE_REQUEST.approve` path imports `executeApprovedBookTravel` directly — every approvable action requires a similar import). A registry would let any action register its resolver function.

### 5.9 Audit-event / owner-type registry

Migrate from: `LIFEOPS_AUDIT_EVENT_TYPES` (33 entries), `LIFEOPS_OWNER_TYPES` (10 entries). Each subsystem registers its types with descriptions for the audit UI.

---

## Section 6 — Recommendations Grouped by Confidence

### High confidence — do these first

1. **Delete `stretch-decider.ts` and the `isStretchDefinition` / `evaluateStretchReminderGate` carve-out in `service-mixin-reminders.ts`.** Stretch is a seeded routine, not a runtime concept. If a reminder needs busy-day-skip / weekend-skip / late-evening-skip, those are policy attributes on the definition's `metadata`, gated through a generic dispatcher gate. (Risk: low — the gate currently fires only for `title === "Stretch"`, which means any other definition is unaffected.)

2. **Move the 9 non-action files out of `src/actions/`:** `extractor-pipeline.ts`, `gmail.ts`, `lifeops-extraction-config.ts`, `lifeops-google-helpers.ts`, `lifeops-grounded-reply.ts`, `non-actionable-request.ts`, `scheduled-trigger-task.ts`, `timezone-normalization.ts`, `CHECKIN_MIGRATION.TODO.md`. They are not actions — they're helpers, configs, or stale TODOs. (Risk: low — pure refactor, but lots of imports to update.)

3. **Resolve the `CHECKIN` migration.** Either delete the action and migrate to scheduled tasks per the TODO, or delete the TODO. The current state (TODO says "removed", action exists) is a lie. (Risk: low.)

4. **Strip PII from source code.** Replace `Jill`, `Marco`, `Sarah` in `actions/calendar.ts`, `actions/lib/calendar-handler.ts`, `actions/lib/scheduling-handler.ts`, `actions/resolve-request.ts`, `actions/life.ts:3509-3517` with generic identifiers (`a colleague`, `my partner`, `someone`). Remove `"daily time with Jill"` from the calendar action's `tags`. (Risk: low — scenario-derived examples can be rewritten.)

5. **Rename PII fixtures and the chat-export catalog.** `lifeops-samantha.json` → `lifeops-presence-active.json`, `ice-bambam-executive-assistant.json` → `executive-assistant-transcript.catalog.json`, `gmail-suran-routing.json` → `gmail-direct-message-sender-routing.json`, plus update `test/helpers/lifeops-prompt-benchmark-cases.ts:138`. Strip the absolute-path reference inside the catalog (`/Users/shawwalters/Desktop/chat-exports/...`) — that's a private export path. (Risk: medium — see Section 9 ordering.)

6. **Delete the duplicate follow-up actions or the `RELATIONSHIP` follow-up subactions.** Pick one path; both is a smell. The standalone actions have richer parameter docs; the umbrella has natural-language coverage. Recommend: keep follow-ups out of `RELATIONSHIP` (rename it to `CONTACTS`), keep `LIST_OVERDUE_FOLLOWUPS` / `MARK_FOLLOWUP_DONE` / `SET_FOLLOWUP_THRESHOLD` as primitives. (Risk: low.)

7. **Collapse `PROFILE.save` and `PROFILE.set` aliases.** Remove `set` — pick one canonical name. (Risk: low.)

8. **Move `set_reminder_preference` and `configure_escalation` off `PROFILE`.** They're not profile data. Either onto a new `REMINDER_POLICY` action or under `LIFE` as policy-on-definition. (Risk: low.)

9. **Strip the 18 hardcoded "always-include" trigger phrases from `calendar.ts:663-684`.** Tags like `"flight conflict"`, `"rebook the other thing"` are scenario rehearsals embedded in the planner prompt — they bias the planner toward specific journeys instead of toward verbs. (Risk: low — should improve the planner.)

10. **Convert `CONNECTOR_DISPATCHERS` to a `ConnectorRegistry`.** Adding a new connector should not require editing `actions/connector.ts`. (Risk: medium — the action surface stays compatible; only the lookup mechanism changes.)

11. **Convert `ROUTINE_SEED_TEMPLATES` to a `RoutineTemplateRegistry` and seed the 8 default templates as one contributor.** This is the change that lets users / cloud packs / app marketplaces add seed packs without forking. (Risk: low.)

12. **Drop the "20 PRD journeys" assertion in `prd-coverage.contract.test.ts:156-164`.** Asserting an exact journey count fights any architectural cleanup that consolidates or splits scenarios. The test should assert "every row in the matrix has a real test file" but not "exactly 20 rows". (Risk: low — single-test relaxation.)

### Medium confidence — defensible but need a design call

13. **Decompose `CALENDAR` into Google-Calendar + Calendly + Negotiation actions.** Pro: cleaner per-connector boundary, per-connector enable/disable, clearer planner targeting. Con: 3 actions instead of 1, more tags for the planner to weigh, possible regressions in cross-connector flows like "find a slot via my Google calendar then send a Calendly link". Decision needed: does the 3-way split improve or hurt the planner? Suggested: keep umbrella, but turn `calendly_*` into a registered-provider sub-action contributed by a Calendly module, and `negotiate_*` into a workflow-lifecycle sub-action.

14. **Move the entire sleep-cycle vocabulary into a contributed extension module.** `LIFEOPS_EVENT_KINDS`, `LIFEOPS_CIRCADIAN_STATES`, `LIFEOPS_REGULARITY_CLASS`, `LifeOpsScheduleInsight`, `LifeOpsPersonalBaseline`, the `relative_to_wake` / `during_morning` workflow kinds — all of this is one bundle of sleep-coupled contracts. It could remain in `lifeops.ts` (sleep is a real first-party feature) or move to `lifeops-sleep.ts` (so the core stays generic and sleep is one of N possible "presence engines"). Decision: depends on whether sleep is core LifeOps or a packaged feature.

15. **Replace `LIFEOPS_REMINDER_CHANNELS` ∪ `LIFEOPS_CHANNEL_TYPES` ∪ `LIFEOPS_MESSAGE_CHANNELS` with a `ChannelRegistry`.** Pro: one source of truth, capability descriptors instead of three overlapping enums. Con: the discrepancies between the three enums (e.g. `browser` only in CHANNEL_TYPES) might be intentional and tied to specific call sites; need to audit each callsite first.

16. **Audit and consolidate the 30-mixin `LifeOpsService`.** Each `service-mixin-*.ts` file's methods are reachable from anywhere, making the dependency direction unclear. Splitting by domain (definitions / occurrences / reminders) vs connector (gmail / x / telegram / …) would clarify where each method belongs.

17. **Rework `LIFEOPS_AUDIT_EVENT_TYPES` (33 entries) into a registered-types model.** Each subsystem registers its event types. Lower priority because audit types are mostly stable.

18. **Generalize the meal vocabulary.** `LifeOpsScheduleMealLabel = "breakfast" | "lunch" | "dinner"` excludes brunch / second lunch / fasting overrides / cultural variants. Use `mealLabel: string` with a registered enum for the planner.

### Low confidence / open questions

19. **Should `BOOK_TRAVEL` and `RELEASE_BLOCK` remain hardcoded compounds, or pluggable workflows?** Currently they're transactional Action handlers with imperative steps. Could be expressed as workflow definitions (`LifeOpsWorkflowAction[]`) that the workflow runner executes. Trade-off: explicit Action = less abstraction but harder to extend; workflow = more abstraction but routing/UX gets fuzzier. **Open question** — needs UX call.

20. **Should `CONTACTS` and `RELATIONSHIPS` be the same entity?** Right now `LifeOpsRelationship` has fields like `relationshipType` and `lastContactedAt` that suggest a relationship-with-cadence model. A pure contact graph would be just `{name, channels[], notes}`. Open: how much cadence semantics belongs on the entity itself vs. on a follow-up rule?

21. **Should multilingual examples like the brush-teeth Spanish prompt live in source code at all?** Or in a translation-table contributed at boot? The hardcoded Spanish ActionExample is a smell, but the alternative (translation table, locale loader) is more infrastructure for one example. Open question.

22. **Should `seed-routines.ts` exist at all?** If first-run onboarding asks the user "want me to set up some habits?", maybe the right answer is to ask the user what habits they want — and not ship eight opinionated defaults baked into the codebase. UX call.

---

## Section 7 — What Should Explicitly Remain Compound

Compound actions whose *steps must execute atomically or transactionally*, or whose UX collapse benefits the user enough to justify the bundling:

| Action | Why compound |
|---|---|
| `BOOK_TRAVEL` (`actions/book-travel.ts`) | Search + missing-detail collection + draft + approval queue + book + payment + calendar sync. Splitting risks partial bookings and approval/payment race conditions. The owner approves *the whole trip*, not each step. |
| `RESOLVE_REQUEST.approve` | Approval is one decision applied to a queued action whose execution is wired in. The dispatcher table should still be a registry, but the action stays one verb. |
| Calendar `bulk_reschedule` | Previewing "push N meetings into a window" is one query (preview) followed by one transactional commit. Can't decompose without losing atomicity. |
| Calendar `negotiate_*` lifecycle | Multi-turn scheduling negotiation is a single long-running actor. The 7 `negotiate_*` subactions are lifecycle verbs (`start`, `propose`, `respond`, `finalize`, `cancel`, `list_active`, `list_proposals`) — all required, all on one entity. Splitting would scatter the negotiation API. |
| `RELEASE_BLOCK` | Verifying state + clearing + audit must run as one. |
| `OWNER_SEND_APPROVAL` flow (`messaging/owner-send-policy.ts`) | Drafting + queueing approval + executing on confirm is one transactional thread. |
| `CHECKIN` (if kept as an action) | Assembling todos + meetings + wins + sleep recap + briefing is a single read-snapshot operation. Splitting it into 5 actions would make the briefing inconsistent (different time slices). However, see §6 #3 — should be a cron task, not an action. |

Anti-pattern (looks compound but isn't): `CONNECTOR.connect+verify+status` is *not* a transactional bundle — they're three independent verbs that share a connector kind. Same for `LIFE.create+update+delete`.

---

## Section 8 — UX Risk Register

For each major recommended change, the user-facing risks:

| Change | Risk |
|---|---|
| Delete `stretch-decider.ts` | The stretch nudge will lose its busy-day-skip / weekend-skip / late-evening cutoff / walk-out reset behaviors *if* no replacement gate is wired before the deletion. Mitigation: the replacement gate registry needs to ship in the same change. Risk medium. |
| Decompose `CALENDAR` umbrella | More planner ambiguity. The current single-CALENDAR routing works because the LLM picks one action and one subaction. Splitting to 3 actions means the LLM has to choose CALENDAR vs CALENDLY vs SCHEDULING first, which can fail when a request spans them ("offer Calendly slots for next week" — is that CALENDAR or CALENDLY?). |
| Strip "always-include" tags from `calendar.ts:663-684` | Possible regression in scenario-trigger recall — the planner might miss requests whose phrasing mirrored those tags. Mitigation: rerun the prompt-benchmark suite after the change. |
| Convert `seed-routines.ts` to a registry | First-run onboarding flow currently lists 8 routines by name in the agent's seeding message (`proactive-worker.ts:581-585`). Converting to a registry means generating that copy from registered contributions, which can drift if no contributor is registered. Mitigation: ensure the default-pack contributor is always registered at plugin init. |
| Convert `CONNECTOR_DISPATCHERS` to a registry | If a connector forgets to register, the `connect` verb silently fails for that kind. Mitigation: register all 9 connectors at plugin init in the same place; assert non-empty registry at boot. |
| Rename PII fixtures | Test imports might point at literal paths. Risk: tests fail until imports are updated. Mitigation: grep for the literal filename before rename (Section 9). |
| Drop `prd-coverage.contract.test.ts` "20 journeys" assertion | Lose a tripwire on coverage shrinkage. Mitigation: keep the "every matrix row has a test file" assertion. |
| Move sleep vocabulary to its own module | If imports break across the 100+ files that touch the sleep types, the build halts. Mitigation: keep the re-exports from `lifeops.ts` for one release cycle. |
| Split `RELATIONSHIP` into `CONTACTS` + `FOLLOW_UPS` | Planner has to reroute "follow up with David" requests. The LLM has been trained against the umbrella; the routingHint copy will need rework. |
| Move 9 non-action files out of `src/actions/` | Pure import churn — no UX risk if compilation passes. |
| Generalize meal vocabulary to `string` | The schedule-insight UI / providers may format meal labels with a closed-set switch. Need to audit before relaxing the type. |

Common cross-cutting risk: **latency from LLM-composing-steps**. If any compound action becomes "let the planner call N primitives", each turn pays for an extra LLM round. The decompositions in Section 6 are mostly registries or splits-of-truly-independent-concerns, not "let the LLM stitch the steps together" — but the `BOOK_TRAVEL`-as-workflow open question (§6 #19) does carry that risk.

---

## Section 9 — Dependencies and Ordering

Suggested order so each step lands cleanly:

1. **Move non-action helpers out of `actions/`** (high-confidence #2). Pure refactor; no other change depends on import paths surviving. Update imports.
2. **Resolve CHECKIN** (high-confidence #3). Pick one resolution; remove or migrate. Independent of everything else.
3. **Strip PII from source code** (high-confidence #4). Independent — they're string literals in descriptions/examples/tags.
4. **Strip "always-include" scenario-rehearsal tags from `calendar.ts`** (high-confidence #9). Independent.
5. **Collapse `PROFILE.save` and `PROFILE.set` aliases; move `set_reminder_preference` / `configure_escalation` off PROFILE** (high-confidence #7, #8).
6. **Resolve duplicate follow-up actions** (high-confidence #6). Decide: standalone primitives or umbrella subactions; remove the other.
7. **Drop "20 journeys" assertion** (high-confidence #12). Done before any decomposition that affects the matrix.
8. **Build `ReminderGateRegistry`, then delete `stretch-decider.ts` and the title-string carve-out in `service-mixin-reminders.ts`** (high-confidence #1). Build the registry first; migrate the stretch gate as the only contributor; verify; then delete the file. Don't delete first.
9. **Build `RoutineTemplateRegistry`; convert `ROUTINE_SEED_TEMPLATES` to a default-pack contributor** (high-confidence #11). The proactive-worker seeding message must read its routine list from the registry.
10. **Build `ConnectorRegistry`; migrate the 9 dispatchers** (high-confidence #10). Big surface but contained inside `actions/connector.ts`.
11. **Rename PII fixtures and the chat-export catalog** (high-confidence #5). Before this rename, grep `test/` for any literal path that mentions the old filenames; update the prompt-benchmark cases helper at `test/helpers/lifeops-prompt-benchmark-cases.ts:138`. Move the rename and the import update into one commit so tests don't fail across the boundary.
12. **Decompose `CALENDAR` into Calendly + negotiation modules** (medium #13). This benefits from steps 9 and 10 being in place.
13. **Move sleep vocabulary to a contributed module** (medium #14). After step 8 (so the gate registry exists, in case sleep contributes any gates).
14. **Replace channel enums with `ChannelRegistry`** (medium #15). After step 10 (connectors register their channels).
15. **Audit / consolidate the 30-mixin `LifeOpsService`** (medium #16). Last — depends on most of the above being settled.

**Ordering hazards to watch:**

- The contract test `prd-coverage.contract.test.ts:156-164` asserting "20 PRD journey rows" and `every test file path … points to an existing file" must be relaxed *before* any test rename, or the rename breaks CI mid-flight.
- `STRETCH_ROUTINE_TITLE` is exported from `seed-routines.ts:21` and imported by `service-mixin-reminders.ts:116`. If the gate registry refactor and the seed-templates refactor land in different commits, the import has to survive the intermediate state. Land them in the same commit, or temporarily re-export.
- The `lifeops-extensions.ts` self-acknowledged "Wave 0 didn't write me" file should be folded back into `lifeops.ts` (or kept and the comment removed) before any further reorganization — leaving "I-was-supposed-to-be-merged" comments in source poisons future readers.
- Several `messagingTriageActions` come from `@elizaos/core` — those aren't LifeOps's to move. Audit imports before renaming any messaging action or adapter.

---

*End of audit. This document does not modify code.*
