# Action / Subaction Hierarchy — Final Audit

Scope: every Action registered in `plugins/app-lifeops/src/plugin.ts` plus the
`messagingTriageActions` provided by `@elizaos/core`. Each entry is
cross-checked against `HARDCODING_AUDIT.md` §6 (narrowed) + §7 (stays
compound), `GAP_ASSESSMENT.md` §8.3 (umbrella-action model), and
`JOURNEY_GAME_THROUGH.md` (journey-to-action mapping).

This audit lands after Waves 1 + 2 + 3 + Cleanup. Drift items below describe
divergences from the post-cleanup plan documented in those files.

## A. Inventory

| Action (`Action.name`) | Source | Subaction param | Subaction values | Cross-check |
|---|---|---|---|---|
| `WEBSITE_BLOCK` | `actions/website-block.ts` | `subaction` | `block`, `unblock`, `status`, `request_permission`, `release`, `list_active` | W2-F: standalone `RELEASE_BLOCK` / `LIST_ACTIVE_BLOCKS` folded in. Match plan. |
| `APP_BLOCK` | `actions/app-block.ts` | `subaction` | `block`, `unblock`, `status` | Match plan. |
| `CALENDAR` | `actions/calendar.ts` | `subaction` | `feed`, `next_event`, `search_events`, `create_event`, `update_event`, `delete_event`, `trip_window`, `bulk_reschedule`, `check_availability`, `propose_times`, `update_preferences` (11 verbs) | W2-C: `calendly_*` and `negotiate_*` extracted. `bulk_reschedule` stays compound per §7. Match plan. |
| `CALENDLY` | `actions/lib/calendly-handler.ts` | n/a (one Calendly verb dispatch) | — | W2-C extraction. Match plan. |
| `SCHEDULING_NEGOTIATION` | `actions/scheduling-negotiation.ts` → `actions/lib/scheduling-handler.ts` | `subaction` | `start`, `propose`, `respond`, `finalize`, `cancel`, `list_active`, `list_proposals` (7 lifecycle verbs) | W2-C: extracted from CALENDAR. **Renamed in this audit** from `SCHEDULING` → `SCHEDULING_NEGOTIATION` (drift fix #1). `SCHEDULING` retained as a one-release simile. |
| `RESOLVE_REQUEST` | `actions/resolve-request.ts` | `subaction` | `approve`, `reject` | Stays one verb per §7.3. Match plan. |
| `DEVICE_INTENT` | `actions/device-intent.ts` | `subaction` | `broadcast` | Match plan. |
| `FIRST_RUN` | `actions/first-run.ts` | `path` (frozen interface) | `defaults`, `customize`, `replay` | `path` field is canonical per `wave1-interfaces.md` §4.2. Match plan. |
| `LIFE` | `actions/life.ts` | `subaction` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` (7 owned ops) | Match plan. **Drift D-3 below**: plan says `set_reminder_preference` / `configure_escalation` should land here under `policy.*`, but they remain on `PROFILE`. |
| `LIFEOPS` | `actions/lifeops-pause.ts` | `verb` (with `subaction` alias) | `pause`, `resume`, `wipe` | W1-C. Match plan. |
| `MESSAGE.handoff` | `actions/message-handoff.ts` | `verb` (with `subaction` alias) | `enter`, `resume`, `status` | W2-G. Match plan. |
| `BOOK_TRAVEL` | `actions/book-travel.ts` | none (compound) | — | Stays compound per §7.1. Match plan. |
| `PROFILE` | `actions/profile.ts` | `subaction` | `save`, `capture_phone`, `set_reminder_preference`, `configure_escalation`. Legacy `set` normalized to `save`. | W2-A collapsed `save`≡`set`. **Drift D-3**: `set_reminder_preference` / `configure_escalation` should be on `LIFE.policy.*` per `HARDCODING_AUDIT` §6 #8 / `IMPLEMENTATION_PLAN` §5.1; storage moved to `OwnerFactStore` (W2-E) but the action surface didn't follow. |
| `ENTITY` | `actions/entity.ts` | `subaction` | Canonical: `add`, `list`, `log_interaction`, `set_identity`, `set_relationship`, `merge`. Transitional: `add_follow_up`, `complete_follow_up`, `follow_up_list`, `days_since`, `list_overdue_followups`, `mark_followup_done`, `set_followup_threshold`. Legacy: `list_contacts`, `add_contact`. | W2-A. **Drift D-2**: plan says only the 6 canonical verbs should remain; the 7 follow-up verbs are explicitly transitional and the file comments themselves note they collapse onto `SCHEDULED_TASK` queries when that umbrella ships in W3-C. `SCHEDULED_TASK` action does not yet exist. |
| `SCREEN_TIME` | `actions/screen-time.ts` | `subaction` | 10 read verbs (`summary`, `today`, `weekly`, `weekly_average_by_app`, `by_app`, `by_website`, `activity_report`, `time_on_app`, `time_on_site`, `browser_activity`) | Match plan (irreducible per-window read surface). |
| `VOICE_CALL` | `actions/voice-call.ts` | `subaction` | `place`, `call_owner`, `call_external` | Match plan. |
| `REMOTE_DESKTOP` | `actions/remote-desktop.ts` | `subaction` | `start`, `status`, `end`, `list`, `revoke` | Match plan. |
| `SCHEDULE` | `actions/schedule.ts` | `subaction` | `summary`, `inspect` | Reads passive sleep/meal inference. **Drift D-4**: post-cleanup architecture says `plugin-health` owns sleep/circadian; this action's `formatScheduleSummary` reaches into circadian state, sleep episodes, meal candidates. The action stays in `app-lifeops`. Punted (bigger surgery). |
| `PASSWORD_MANAGER` | `actions/password-manager.ts` | `subaction` | `search`, `list`, `inject_username`, `inject_password` | Match plan. |
| `AUTOFILL` | `actions/autofill.ts` | `subaction` | `fill`, `whitelist_add`, `whitelist_list` | Match plan. |
| `HEALTH` | `actions/health.ts` | `subaction` | `today`, `trend`, `by_metric`, `status` | Match plan. |
| `SUBSCRIPTIONS` | `actions/subscriptions.ts` | `mode` | `audit`, `cancel`, `status` | **Drift D-5**: discriminator is `mode`, not `subaction`. Convention drift. |
| `PAYMENTS` | `actions/payments.ts` | `mode` | `dashboard`, `list_sources`, `add_source`, `remove_source`, `import_csv`, `list_transactions`, `spending_summary`, `recurring_charges` | **Drift D-5**: same `mode` vs `subaction` convention drift. |
| `CONNECTOR` | `actions/connector.ts` | `subaction` | `connect`, `disconnect`, `verify`, `status`, `list` | W2-B: `ConnectorRegistry`-backed. Match plan. |
| `TOGGLE_FEATURE` | `actions/toggle-feature.ts` | n/a (`featureKey` + `enabled`) | — | Single-verb action. Match plan. |
| `MESSAGE`, `MESSAGE.attachments`, `MESSAGE.ack`, … | `messagingTriageActions` from `@elizaos/core` | varies | varies | Out of LifeOps scope. |

The plan items the inventory verifies green:

- `ENTITY` carries the W2-A canonical 6 verbs (drift only on the transitional follow-up subactions).
- `RELATIONSHIP` is preserved as a `simile` of `ENTITY` for one-release planner back-compat.
- `CHECKIN` action does not exist (driven by daily-rhythm pack).
- `CALENDAR` is narrowed to 11 irreducible verbs (`calendly_*` and `negotiate_*` extracted per W2-C).
- `WEBSITE_BLOCK` owns `release` + `list_active`; standalone `RELEASE_BLOCK` / `LIST_ACTIVE_BLOCKS` actions are gone (W2-F).
- `PROFILE.save` is canonical; `set` collapses onto it.
- `BOOK_TRAVEL` stays compound.
- `MESSAGE.handoff` exists.
- `LIFEOPS` exposes `pause` / `resume` / `wipe`.

## B. Drift Found

### D-1 (HIGH confidence — fixed)

`schedulingNegotiationAction.name === "SCHEDULING"` instead of
`"SCHEDULING_NEGOTIATION"`. The export filename and integration test
(`test/lifeops-action-gating.integration.test.ts:106-124`) both expect
`"SCHEDULING"` to be absent from the registered action list — only
`SCHEDULING_NEGOTIATION` should exist. The file at
`actions/scheduling-negotiation.ts` re-exports `schedulingAction` whose inner
`name` field never moved off `"SCHEDULING"`. The test was failing on
`develop` for this reason.

### D-2 (MEDIUM confidence — punted)

`ENTITY` still exposes 7 transitional follow-up subactions
(`add_follow_up`, `complete_follow_up`, `follow_up_list`, `days_since`,
`list_overdue_followups`, `mark_followup_done`, `set_followup_threshold`).
Per `HARDCODING_AUDIT` §6 #6 and `entity.ts` lines 23-33, these are intended
to collapse onto `SCHEDULED_TASK` queries when that umbrella ships in W3-C.
`SCHEDULED_TASK` action does not yet exist (only the runtime + routes
exist). Removing the verbs now would strand follow-up traffic.

Punt reason: cannot remove the verbs until `SCHEDULED_TASK` exists; the
in-source comments already document the transitional state. Follow-up work
in W3-C.

### D-3 (MEDIUM confidence — punted)

`PROFILE.set_reminder_preference` and `PROFILE.configure_escalation` should
move to `LIFE.policy.*` (or a dedicated `REMINDER_POLICY` action) per
`HARDCODING_AUDIT.md` §6 #8 and `IMPLEMENTATION_PLAN.md` §5.1. W2-E moved
the storage onto `OwnerFactStore` (see `lifeops/owner/fact-store.ts:13`),
but the action surface still lives on `PROFILE`.

Punt reason: relocating the action verbs flips the planner contract. The
storage migration is complete; the verb migration is the remaining step.
Better landed in one focused commit alongside any planner-prompt updates,
not in this hierarchy audit. Storage path is correct today.

### D-4 (MEDIUM confidence — punted)

`SCHEDULE` action (`actions/schedule.ts`) lives in `app-lifeops` but reaches
into `LifeOpsScheduleInspection` to render circadian state, sleep episodes,
and meal candidates. `post-cleanup-architecture.md` says `plugin-health`
owns sleep / circadian / screen-time. This action is one of the inference
read surfaces that ought to live in `plugin-health` (or read from a
plugin-health-contributed inspection contract).

Punt reason: moving the action requires migrating `LifeOpsScheduleInspection`
and the underlying service surface; out of scope for a hierarchy audit.

### D-5 (LOW confidence — punted)

`SUBSCRIPTIONS` and `PAYMENTS` use a `mode` parameter rather than the
`subaction` convention used by every other umbrella. The Action contract
does not require any specific name for the discriminator field, but the
inconsistency makes the `resolveActionArgs` substrate not reusable for
these two actions and creates planner-schema variance.

Punt reason: changing the parameter name flips the planner contract for
both actions; needs to land alongside a planner-side update and benchmark
re-run.

## C. Fixes Applied (this commit)

- `plugins/app-lifeops/src/actions/lib/scheduling-handler.ts`:
  - `schedulingAction.name`: `"SCHEDULING"` → `"SCHEDULING_NEGOTIATION"`.
  - Added `"SCHEDULING"` to `similes` for one-release planner back-compat
    (mirrors the W2-A `RELATIONSHIP` → `ENTITY` rename pattern).
  - `actionName: "OWNER_CALENDAR"` callback strings (4 sites) replaced with
    the actual Action name each handler belongs to:
    `PROPOSE_MEETING_TIMES`, `CHECK_AVAILABILITY`, `UPDATE_MEETING_PREFERENCES`,
    `SCHEDULING_NEGOTIATION`. The previous `OWNER_CALENDAR` string had no
    matching Action and was a stale historical reference.
  - `description` prose: stale `OWNER_CALENDAR` and `SCHEDULING` token
    references updated to `CALENDAR` and `SCHEDULING_NEGOTIATION`
    respectively, so planner copy advertises actual Action names.
- `plugins/app-lifeops/src/actions/lib/calendar-handler.ts`:
  - `action: "OWNER_CALENDAR"` callback string in the `GOOGLE_CALENDAR`
    handler replaced with `"GOOGLE_CALENDAR"`.
  - `description` prose: `OWNER_CALENDAR` and `OWNER_LIFE` token references
    replaced with `PROPOSE_MEETING_TIMES` and `LIFE` respectively (those are
    the actual registered action names).

## D. Verification

- `bunx tsc --noEmit -p tsconfig.build.json` clean.
- `bun test journey-domain-coverage` — 40/40 pass.
- `bun test w2c-calendar-decomposition` — 50/50 pass.
- `bun test lifeops-action-gating` — the
  `expect(actionNames).not.toContain("SCHEDULING")` assertion now passes
  (was failing pre-fix because the registered Action name was still
  `"SCHEDULING"`). Two unrelated failures (`MESSAGE` validate gating,
  `ENTITY` non-owner reject) are pre-existing and out of this audit's
  scope.

## E. Follow-ups

- D-2 and D-3 land cleanly together once a `SCHEDULED_TASK` umbrella action
  ships (W3-C). The transitional follow-up subactions migrate to
  `SCHEDULED_TASK.list({ kind: "followup", … })` and the policy verbs move
  off `PROFILE` to `LIFE.policy.*`.
- D-4 lands when `plugin-health` absorbs the inference action surface.
- D-5 needs a planner-prompt + benchmark re-run to confirm the rename does
  not regress `SUBSCRIPTIONS` / `PAYMENTS` recall.
