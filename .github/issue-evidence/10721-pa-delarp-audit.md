# Personal-assistant de-larp audit (#10721) — critical assessment, slice 1

A ranked, evidence-backed audit of `plugins/plugin-personal-assistant` against the
issue's targets (larp/stubs, weak typing, frozen-contract violations,
`promptInstructions`-content-driven behavior, untested branches). Findings were
produced by a 4-category parallel audit and **re-verified against the code**; each
is marked **fixed-in-this-PR** or **scoped follow-up** (with why).

Frozen contracts (per `plugins/plugin-personal-assistant/README.md`): a single
`ScheduledTask` runner (no second scheduler); `EntityStore`/`RelationshipStore`
only; behavior structural on `kind`/`trigger`/`shouldFire`/`completionCheck`/
`pipeline` — never on `promptInstructions` string content; connector dispatch
returns a typed `DispatchResult` — never a bare `boolean`.

## HIGH — top priorities (scoped follow-ups; too risky to fix blind)

### H1. A second LifeOps scheduling mechanism fires GM/GN/nudges directly, bypassing the single runner
`src/activity-profile/proactive-worker.ts:478-559,940-1005` (wired `src/plugin.ts:1005,1012`). The proactive worker builds its **own** schedule and fires user-facing messages itself — its own `scheduledFor` timing gate, its own `recordFiredAction` fire-log, and direct `runtime.sendMessageToTarget(...)` / `emitProactiveAssistantEvent(...)` — never routing through the `ScheduledTask` runner. Registered by default (`registerProactiveTaskWorker` + `ensureProactiveAgentTask`; task description literally *"Proactive agent: GM/GN/nudges based on activity profile"*). **GM/GN are ALSO the `daily-rhythm` ScheduledTask pack → double-scheduled.** Violates the README's "There is no second LifeOps scheduling mechanism" invariant, and bypasses the runner's `shouldFire` gates, global-pause, send-policy, escalation ladder, and typed `DispatchResult`.
**Follow-up:** model GM/GN/nudges/downtime/goal-check-ins/quiet-user nags as `ScheduledTask` records (they already exist as `daily-rhythm`/watcher/checkin packs); delete the parallel planner + fire-log + direct dispatch. Large, behavior-sensitive refactor — must be done with real-runtime scenario evidence, not blind.

### H2. Soft-failure `DispatchResult {ok:false}` is silently recorded as a successful fire (retry/escalation is dead code) — CONFIRMED REAL BUG
`plugins/plugin-scheduling/src/scheduled-task/runner.ts:~1117-1124` returns `{ kind: "fired", task }` whenever a `dispatchResult` exists — it **never branches on `dispatchResult.ok === false`**. The production dispatcher returns `{ok:false}` for **disconnected channels** and **send-policy denials**, so those are recorded as "fired": the user silently never receives the message, and `src/lifeops/connectors/dispatch-policy.ts` `decideDispatchPolicy` (retry/backoff/escalation) is **never called** — dead code.
**Follow-up:** after `dispatchResult = await dispatcher.dispatch(...)`, branch on `!dispatchResult.ok` and route through `decideDispatchPolicy` (retry/hold/escalate) instead of `{kind:"fired"}`. Changes dispatch/retry behavior across every scheduled item — needs dedicated tests + real-runtime evidence. (Also: `runtime-wiring.ts:257-281` mislabels `require_approval` denials as `auth_expired`, mis-driving that same policy.)

## MEDIUM / LOW — ranked follow-ups

- **Google reminder-plan deletion is a no-op stub with a misleading comment** — `src/lifeops/domains/google-service.ts:226-232` `deleteCalendarReminderPlansForEvents` is empty; both `clearGoogleConnectorData` (145) and `clearGoogleGrantData` (181) call it expecting real deletion. No `withCalendar` override exists (verified pre- and post-refactor); `life_reminder_plans` has no FK/cascade to calendar events. → disconnecting Google / deleting a grant **orphans reminder-plan rows**. Fix: implement real deletion in `LifeOpsRepository` or remove the dead call sites + false comment.
- **Duffel connector advertises `orders.read`/`orders.create` it never implements** — `src/lifeops/connectors/duffel.ts:26-31,76-87`; `read` ignores the capability and always calls `searchFlights`. `registry.byCapability("duffel.orders.create")` resolves a connector that only searches flights. Fix: trim capabilities to what's served, or route order verbs to the real order path.
- **`setPreferredGoogleConnectorMode` is a dead stub** — `google-service.ts:234-239` returns `null`, ignores both args, zero callers, exposed publicly via `service.ts:395`. Fix: implement (persist + return grant) or delete method + facade.
- **`checkin-service.ts:736` counts "action needed" by substring-matching a display `reason` label** instead of the structural `replyNeeded` field (label source `303-306`). *(A structural-field fix was drafted this PR but reverted pending checkin-test validation — see below.)* Fix: carry `replyNeeded` structurally and count on it.
- **`processDueScheduledTasks` error-recording branches are untested** — `src/lifeops/scheduled-task/scheduler.ts:157-167,191-197,235-242,271-281` (completion_timeout/fire/pending_prompt/dispatch_failed → `result.errors`) have zero positive coverage. Fix: inject throwing stubs + a `dispatch_failed` dispatcher, assert `result.errors`.
- **Untyped `as` casts at real boundaries** — proactive dispatch emits via an `as` cast defeating the typed event contract (`proactive-worker.ts:889-903`, dup `runtime-wiring.ts:298-306`); `approval-queue.ts:775` double-casts through `unknown`; `plugin.ts:911-937` stashes registries onto the runtime via untyped intersection casts (read them back through the typed accessors instead).
- **DST-incorrect `endOfLocalDayMs`** — `src/actions/lib/scheduling-handler.ts:181-185` assumes a fixed 1440-minute local day; wrong near spring-forward/fall-back. Fix: compute next local midnight via zoned parts. (The new `timezone.test.ts` in this PR protects the resolver these depend on.)
- **Delegation-failure HTTP status decided by substring-matching a free-text reason** — `x-service.ts:135` (dup `whatsapp-service.ts:279`, `x-read-service.ts:63`). Fix: add a typed `reasonCode` discriminant to the unavailable variant.

## Fixed in this PR (verified)

1. **Discord `DispatchResult` reported `channelId` as `messageId`** — `src/lifeops/connectors/discord.ts`. `sendDiscordMessage` returns no per-message id (only a `channelId`), yet the connector did `return { ok: true, messageId: result.channelId }`, corrupting the dispatch state log. **Fixed:** `return { ok: true }` (messageId is optional on the success variant, matching the Google connector). Biome-clean; mirrors the proven `google.ts` pattern.
2. **Timezone resolver had no unit coverage** — added `src/lifeops/time/timezone.test.ts` (**17 tests, all pass** under the plugin's vitest): alias map (pst/est/cst→IANA), explicit-IANA passthrough, longest-alias precedence, city inference. Locks the resolver that drives scheduling timezone selection (and guards the DST follow-up above).

*(Reverted from this PR pending validation: the `checkin-service.ts` structural-signal refactor and a `scheduler.ts` error-branch test — both are listed above as follow-ups; the checkin refactor needs the checkin test suite green to verify no behavior change, and the scheduler test needs its mock-setup reworked for the plugin's vitest config.)*

## `promptInstructions`-content-driven behavior
**None found** driving control flow (the frozen contract holds). The two "free-text branch" smells above (checkin label substring-match, delegation-status substring-match) are on display/reason strings, not `promptInstructions`, and are listed as typed-discriminant follow-ups.
