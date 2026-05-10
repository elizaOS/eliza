# Post-Wave-2 Ambiguity Register

Companion to `IMPLEMENTATION_PLAN.md` §7.3 (W3-C). Each entry is something
the 28-domain journey replay surfaced that the spec did not pin. Severity
classifies impact on the W1-A `ScheduledTask` spine + W1/W2 capability
contract; "Triage" notes whether W3-C closed the ambiguity in code or
escalated to the wave coordinator for explicit punt.

| ID | Theme | Domain(s) | Severity | Triage |
|---|---|---|---|---|
| A1 | `pipeline.onFail` does not have a runner-level verb to mark a task `failed`; the only path to `failed` is via the pipeline propagation path (`runner.pipeline(taskId, "failed")`). The schema lists `failed` as a terminal state and `onFail` as a pipeline branch, but no verb sets it. | 12, 22 | Medium | **Punt** — surfaced in test `Game-through fix — terminal-state taxonomy`. Decision recorded: `failed` is a runtime-only outcome (e.g. dispatcher error) — there is no chat verb. Spec assumed but not stated. |
| A2 | `expired` is not surfaced by any verb either; it is a scheduler-tick-only transition. The runner exposes `apply(verb)` but `expired` is reachable only through wall-clock advancement on a `once` trigger. The spine's terminal-state taxonomy lists 5 states but only 3 are user-driven (`completed`, `skipped`, `dismissed`). | 5, 8, 17 | Medium | **Punt** — see A1 rationale; the runner's `apply()` deliberately does not accept an `expire` verb. |
| A3 | `kind: "output"` mixes two semantics: (a) the artifact destination (e.g. gmail draft, apple notes) and (b) the in-flight task that produced it. The spine has both `kind: "output"` and `output: { destination }` on the task, allowing redundant or conflicting combinations (e.g. `kind: "reminder"` + `output: { destination: "gmail_draft" }`). | 9, 19 | Low | **Closed** — `Game-through fix — output destination` test asserts every documented destination accepts a schedule call. Curators should prefer `kind: "output"` for artifact-emitting tasks; the runner does not enforce this. Spec note added to the matrix-domain row 19. |
| A4 | `subject.kind: "thread"` vs `subject.kind: "calendar_event"` overlap when a calendar event spawns a thread (J7). The journey trace shows handoff-watchers using `thread`, but a meeting-recap watcher uses `calendar_event` — the spine has no migration path if the subject identity changes mid-flow. | 8, 14 | Low | **Punt** — captured in `Domain 14 — Group chat handoff` test. Workaround: use `metadata.subjectAlias` for the secondary identity. |
| A5 | `respectsGlobalPause: false` tasks that fire during pause have no policy for `pipeline.onComplete` children — do those children inherit the bypass, or do they fall back to `respectsGlobalPause: true` by default? The runner's `schedule()` carries the field through structurally but the spec is silent. | 7, 13, 17 | Medium | **Closed in code, soft-punt in spec** — `Game-through fix — respectsGlobalPause` test confirms the field is preserved. Recommend default-pack curators set `respectsGlobalPause` explicitly on every pipeline child and not rely on inheritance. |
| A6 | `metadata.escalationCursor` is the runner's persistence channel for the snooze-reset rule, but the field is documented as "opaque" — a downstream consumer that wants to surface "currently on step 2 of escalation" must reach into a private namespace. | 7, 22 | Low | **Punt** — `Game-through fix — snooze-resets-ladder` test asserts the cursor shape, locking the schema de-facto even without a public type export. |
| A7 | `kind: "approval"` task that times out: should it transition to `expired` (no decision = abandoned) or `skipped` (treated as user dismissed)? The spec leaves this open; J6/J11 treat them inconsistently. | 10, 17 | Medium | **Punt** — left to default-pack-level configuration via `completionCheck.followupAfterMinutes` + `pipeline.onSkip`. The runner does not bake a default. |
| A8 | `idempotencyKey` honors the dedupe rule on `schedule()`, but the spec doesn't say what happens on `apply(edit)` — can edit change the idempotency key? Today it can (`Object.assign(task, payload)` in `applyEdit`). That means a curator can break dedupe semantics post-hoc. | 1, 4, 10 | Low | **Closed** — `Game-through fix — idempotencyKey` test locks the schedule-time semantic. Edit-time mutation is an open design decision; recommend the runner refuse `edit` payloads that touch `idempotencyKey`. |
| A9 | `trigger.kind: "after_task"` with `outcome: TerminalState` accepts `outcome: "expired" | "failed" | "dismissed"` but no test in the journey set exercises those branches. The runner accepts them structurally; behavior on actual chain-after-expired is unverified. | 4, 10, 26 | Low | **Punt** — schedule call accepts the trigger; runtime evaluation is out of scope for W3-C since the runner doesn't auto-fire from `after_task` triggers (the scheduler tick is the entry point, not present in the in-memory test fixture). |
| A10 | First-run `wakeTime` parsing accepts free-text ("6:30am") in `runDefaultsPath`, but the customize path's tz/window extraction is undefined — see `Game-through finding 9.1`. The Wave-2 customize path was not exercised by W3-C since W2-E's multilingual prompt registry is the right test surface. | 1, 24, 27 | Medium | **Punt** — explicitly out of scope for W3-C per IMPL §7.3 (it's a W3-A default-pack-curation concern, not a spine concern). |
| A11 | `escalation.steps[].channelKey` is a free string today; the runner does not validate against `ChannelRegistry`. A typo (`"in-app"` vs `"in_app"`) silently fails at dispatch time. | 7, 22 | Medium | **Punt** — defer to W2-B's connector + channel migration to add a runtime validation gate. The replay test confirms the schema accepts arbitrary keys without runner edits. |
| A12 | `ownerVisible: false` tasks (shadow watchers, internal pipelines) still appear in `runner.list({})` without a filter. The spec lists `ownerVisibleOnly` on `ScheduledTaskFilter` but no test asserts the default-list behavior is "include both". | 14, 18, 23 | Low | **Closed** — `Domain 14` and `Domain 25` tests both rely on the inclusive-default behavior; no spec change needed but documenting it here so a future filter-change isn't silent. |

## Summary

- **12 ambiguity entries surfaced** across the 28-domain replay.
- **4 closed in code** (`A3`, `A5`, `A8`, `A12`) — the journey-replay
  test asserts the de-facto behavior so a future regression trips.
- **8 punted to the wave coordinator** with explicit rationale; none are
  blockers for shipping the W1-A spine.
- **0 high-severity** entries — the spine schema absorbs every documented
  journey domain without source-code edits.

## How to use this register

When a new journey or default pack surfaces an unhandled case:

1. Check the table for an existing entry — if matched, link the new
   journey to the entry's `Domain(s)` column.
2. If no entry matches, add a new row. Severity guidance: `High` =
   spine schema cannot express the case; `Medium` = expressible but
   silent failure mode; `Low` = expressible and observable but the spec
   is silent on which knob to use.
3. Update the matching `Triage` cell when the entry is closed in code
   or explicitly punted.

## Companion docs

- `docs/audit/UX_JOURNEYS.md` — 28 chapters that anchor the matrix.
- `docs/audit/JOURNEY_GAME_THROUGH.md` — 18 traced journeys + 10 top
  findings.
- `docs/audit/GAP_ASSESSMENT.md` §2.3 / §8.10–§8.12 — the resolved
  game-through findings the W3-C replay locks down.
- `coverage-matrix.md` — the matrix W3-C re-anchored on
  `test/journey-domain-coverage.test.ts` for row 28.

## Post-final-fix updates

- **A6 — Closed in code.** `ScheduledTaskRunner` now exposes
  `getEscalationCursor(taskId): Promise<EscalationCursorView | null>` with
  the `EscalationCursorView` shape `{ stepIndex, lastFiredAt, channelKey }`.
  Consumers no longer reach into `metadata.escalationCursor` directly. The
  accessor resolves `channelKey` through the same `resolveEffectiveLadder`
  path the runner uses internally, so a cursor reflecting "step N" surfaces
  the channel that step is configured to dispatch on. Unit coverage in
  `src/lifeops/scheduled-task/runner.test.ts` (`getEscalationCursor (A6)`).
- **A9 — Closed in code.** `src/lifeops/scheduled-task/after-task-chain.test.ts`
  asserts that `trigger.kind: "after_task"` accepts every `TerminalState`
  outcome (`completed | skipped | dismissed | expired | failed`) and that
  the child task remains `scheduled` when the parent reaches the recorded
  terminal state. The runner's in-memory fixture has no scheduler tick, so
  the test pins the documented invariant (no auto-fire from `after_task` —
  the scheduler tick is the entry point) rather than asserting runtime
  auto-fire. If a future evaluator is wired in, this test is the canonical
  seam to flip.
