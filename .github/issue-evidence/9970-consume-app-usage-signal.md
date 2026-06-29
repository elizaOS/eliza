# #9970 — Consume the ambient app-usage signal (proactive focus-defer) + document mobile constraint

Follow-up slice to merged #10083 (ambient app-usage provider) and #10080
(PRIORITIZE production loaders). Closes the review gap: *"the app-usage signal
is now injected into provider context, but I did not find a downstream
PRIORITIZE/proactive consumer yet."*

## What changed

1. **Proactive worker now acts on the signal, not just displays it.**
   - `plugins/plugin-personal-assistant/src/activity-profile/focus-session.ts` (new) —
     pure helpers + a read path over the **same** `getLatestForegroundActivity`
     source the ambient provider uses. A sustained single-app foreground dwell
     (≥ `FOCUS_SESSION_MIN_MS` = 10m) is a focus session.
   - `proactive-worker.ts::executeProactiveTask` — while the owner is in a focus
     session, non-urgent `goal_check_in` nudges defer to the next tick instead of
     interrupting deep work, logging `[proactive] Owner in focus session (<app>
     <n>m); deferring <k> non-urgent nudge(s) to next tick.`
   - Time-critical kinds always pass through: `pre_activity_nudge` (imminent
     meetings), `gm`/`gn` (daily greetings), and `social_overuse_check` (already
     self-gated on *detected* overuse — a sustained dwell in a distracting app is
     exactly when it should fire).
   - Deferral leaves the fired log untouched → deferred nudges retry once focus
     ends. **No second scheduler; no dropped delivery** — respects the
     single-LifeOps-scheduler rule.

2. **Mobile constraint documented (acceptance criterion #4).**
   - `plugins/plugin-native-mobile-signals/src/definitions.ts` — documents
     `rawUsageExportAvailable: false` as a *permanent* Apple
     DeviceActivity/FamilyControls constraint (not a TODO), plus the coarse
     summary / threshold-event flags it pairs with.
   - Scope note: iOS coarse-summary/threshold *ingestion* into the read path is
     intentionally **not** implemented here. The current iOS signal carries only
     availability flags + `authorization.status` — **no coarse usage data is
     emitted by any producer yet**. A reader for non-existent data would be a
     speculative extension point. The signal spine (`life_activity_signals`,
     `source: "mobile_health"`) already accepts these signals when POSTed and is
     gated on `authorization.status === "approved"`; the aggregator should follow
     the Android `androidUsageRowsFromSignals` precedent **once a native iOS
     coarse-summary producer lands**.

## Verification

- `vitest run src/activity-profile/focus-session.test.ts` → **9/9 pass**
  (threshold classification, kind partitioning, read-path success/throw/idle).
- `vitest run src/activity-profile/proactive-worker.test.ts` → **2/2 pass**
  (no regression in delivery routing).
- `tsc --noEmit` → **0 errors in the changed files** (`focus-session.ts`,
  `proactive-worker.ts`, `definitions.ts`). Remaining worktree typecheck errors
  are pre-existing unbuilt sibling-plugin `.d.ts` (`@elizaos/plugin-inbox`,
  `-finances`, `-calendly`, `-blocker`, `-native-activity-tracker`) in files this
  PR does not touch — a build-ordering artifact of an isolated worktree; turbo CI
  builds deps first.
- `biome check` on the changed files → **clean**.

## Evidence types (per PR_EVIDENCE.md)

- **Real-LLM trajectory:** N/A — this is a deterministic worker gate, not an
  agent/action/prompt/model change. The decision is pure structural logic over
  the activity spine, covered by unit tests.
- **Backend logs:** the new `[proactive] Owner in focus session …` structured
  log (`boundary: activity_profile`, `operation: proactive_focus_defer`) marks
  the consumed signal and deferred kinds.
- **Frontend / screenshots / video / audio:** N/A — no UI or voice surface.
