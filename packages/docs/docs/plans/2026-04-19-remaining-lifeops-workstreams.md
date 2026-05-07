# Remaining LifeOps Scenario Closure Workstreams

Date: 2026-04-19

Scope: classify the remaining `NotYetImplemented` LifeOps scenarios into ten disjoint workstreams, using ten subagent research passes, and separate stale placeholder tests from real runtime backlog.

## Remaining NYI Surface

1. `test/scenarios/activity/activity.context-aware-response.scenario.ts`
2. `test/scenarios/activity/activity.per-app.weekly-average.scenario.ts`
3. `test/scenarios/browser.lifeops/lifeops-extension.see-what-user-sees.scenario.ts`
4. `test/scenarios/calendar/calendar.calendly.navigate.scenario.ts`
5. `test/scenarios/calendar/calendar.create.travel-time.scenario.ts`
6. `test/scenarios/gateway/billing.20-percent-markup-applied.scenario.ts`
7. `test/scenarios/gateway/bluebubbles.imessage.receive.scenario.ts`
8. `test/scenarios/gateway/bluebubbles.imessage.send-blue.scenario.ts`
9. `test/scenarios/gateway/discord-gateway.bot-routes-to-user-agent.scenario.ts`
10. `test/scenarios/gateway/telegram-gateway.bot-routes-to-user-agent.scenario.ts`
11. `test/scenarios/gateway/twilio.call.receive.scenario.ts`
12. `test/scenarios/gateway/twilio.sms.receive-route-to-agent.scenario.ts`
13. `test/scenarios/gateway/whatsapp-gateway.bot-routes-to-user-agent.scenario.ts`
14. `test/scenarios/goals/goal.career.quarterly-review.scenario.ts`
15. `test/scenarios/goals/goal.experience-loop.learn-from-completion.scenario.ts`
16. `test/scenarios/goals/goal.experience-loop.weekly-review.scenario.ts`
17. `test/scenarios/goals/goal.health.track-progress.scenario.ts`
18. `test/scenarios/goals/goal.relationship.track-progress.scenario.ts`
19. `test/scenarios/lifeops.habits/habit.missed-streak.escalation.scenario.ts`
20. `test/scenarios/lifeops.habits/habit.pause-while-traveling.scenario.ts`
21. `test/scenarios/messaging.cross-platform/cross-platform.escalation-to-user.scenario.ts`
22. `test/scenarios/messaging.cross-platform/cross-platform.group-chat-gateway.scenario.ts`
23. `test/scenarios/messaging.discord-local/discord.local.mute-channel.scenario.ts`
24. `test/scenarios/messaging.imessage/imessage.cross-reference-contact.scenario.ts`
25. `test/scenarios/messaging.telegram-local/telegram.local.mute-chat.scenario.ts`
26. `test/scenarios/messaging.twitter-dm/twitter.dm.schedule-reply.scenario.ts`

## Classification Summary

### Convert now with real assertions

- `activity.context-aware-response` if narrowed to current screen focus/context instead of literal app-window identity
- `lifeops-extension.see-what-user-sees`
- `calendar.calendly.navigate` if the scenario means browser navigation/open-link rather than full booking completion
- `discord-gateway.bot-routes-to-user-agent`
- `twilio.sms.receive-route-to-agent`
- `bluebubbles.imessage.receive`
- `bluebubbles.imessage.send-blue`
- `imessage.cross-reference-contact` if it asserts `SEARCH_ENTITY` / `READ_ENTITY` style contact resolution instead of generic fallback
- `goal.health.track-progress`
- `goal.relationship.track-progress`
- `discord.local.mute-channel`

### Convert only if narrowed to current runtime semantics

- `goal.career.quarterly-review` can be remapped onto `review_goal`, but only by dropping the current quarter-specific seeded-memory semantics
- `calendar.calendly.navigate` if the scenario currently implies full browser-task completion
- `activity.context-aware-response` if the scenario currently implies literal current app title or window identity

### Real runtime backlog

- `activity.per-app.weekly-average`
- `calendar.create.travel-time`
- `telegram-gateway.bot-routes-to-user-agent`
- `whatsapp-gateway.bot-routes-to-user-agent`
- `twilio.call.receive`
- `billing.20-percent-markup-applied`
- `goal.experience-loop.learn-from-completion`
- `goal.experience-loop.weekly-review`
- `habit.missed-streak.escalation`
- `habit.pause-while-traveling`
- `cross-platform.escalation-to-user`
- `cross-platform.group-chat-gateway`
- `telegram.local.mute-chat`
- `twitter.dm.schedule-reply`

## Workstream 1: Activity Analytics

Owner: `Nash`

Scenarios:
- `activity.context-aware-response`
- `activity.per-app.weekly-average`

Status:
- `activity.context-aware-response`: convertible now only if scoped to existing screen-context focus
- `activity.per-app.weekly-average`: real runtime gap

Exact seams:
- `eliza/plugins/app-lifeops/src/activity-profile/service.ts`
- `eliza/plugins/app-lifeops/src/providers/activity-profile.ts`
- `eliza/plugins/app-lifeops/src/actions/screen-time.ts`
- `eliza/plugins/app-lifeops/src/actions/screen-time.ts`
- `eliza/plugins/app-lifeops/src/lifeops/service-mixin-screentime.ts`
- `eliza/plugins/app-lifeops/src/lifeops/screen-context.ts`

Implementation TODOs:
- Rewrite `activity.context-aware-response` to seed deterministic screen focus through the current activity-profile test seam and assert the response/action uses that focus.
- Keep the scenario honest about current capability: it should mean “current focus/context,” not “exact app window title,” unless that data is added to runtime.
- Add a dedicated server-side weekly-average-by-app computation path before converting `activity.per-app.weekly-average`.
- Expose structured average fields in the action result instead of letting any client/scenario infer them from raw totals.

Acceptance criteria:
- Context-aware response proves the current focus source is read from runtime state.
- Weekly average returns named average fields per app from server-side computation.

## Workstream 2: Browser Current-Page Context

Owner: `Aquinas`

Scenarios:
- `lifeops-extension.see-what-user-sees`

Status:
- convertible now

Exact seams:
- `eliza/plugins/app-lifeops/extensions/lifeops-browser/entrypoints/content.ts`
- `eliza/plugins/app-lifeops/extensions/lifeops-browser/src/page-extract.ts`
- `eliza/plugins/app-lifeops/extensions/lifeops-browser/entrypoints/background.ts`
- `eliza/plugins/app-lifeops/src/lifeops/service-mixin-browser.ts`
- `eliza/packages/shared/src/contracts/lifeops.ts`
- `eliza/plugins/app-lifeops/test/helpers/browser-portal-scenario-fixture.ts`

Implementation TODOs:
- Replace the placeholder scenario with a real page-context seed.
- Assert `MANAGE_LIFEOPS_BROWSER` is selected.
- Assert `parameters.command === "read_current_page"`.
- Assert the result contains real page fields such as URL, title, and selection text.

Acceptance criteria:
- The scenario fails unless the browser page context was actually ingested and read back.

## Workstream 3: Calendar Travel-Time Creation

Owner: `Peirce`

Scenarios:
- `calendar.create.travel-time`

Status:
- real runtime gap

Exact seams:
- `eliza/plugins/app-lifeops/src/actions/calendar.ts`
- `eliza/plugins/app-lifeops/src/actions/scheduling.ts`
- `eliza/plugins/app-lifeops/src/travel-time/action.ts`
- `eliza/plugins/app-lifeops/src/travel-time/service.ts`
- `eliza/plugins/app-lifeops/src/lifeops/owner-profile.ts`
- `eliza/packages/shared/src/contracts/lifeops.ts`

Implementation TODOs:
- Extend calendar create extraction to emit structured travel origin, destination, and buffer intent.
- Reuse `TravelTimeService` rather than adding another route-time calculator.
- Persist travel-buffer fields on the created event or attach a separate typed travel-buffer result.
- Add scenario assertions against structured payload fields, not response prose.

Acceptance criteria:
- Creating an event with travel-time language produces typed travel inputs and a deterministic travel-buffer computation.

## Workstream 4: Calendly And External Booking Flow

Owner: `Boyle`

Scenarios:
- `calendar.calendly.navigate`

Status:
- convertible now only if the scenario means navigation/open-link
- real runtime gap if the scenario means full browser-task booking completion

Exact seams:
- `eliza/plugins/plugin-calendly/src/actions/book-slot.ts`
- `eliza/plugins/app-lifeops/src/actions/calendly.ts`
- `eliza/plugins/app-lifeops/src/actions/calendar.ts`
- `eliza/plugins/app-lifeops/src/lifeops/browser-session-lifecycle.ts`
- `eliza/plugins/app-lifeops/test/helpers/browser-portal-scenario-fixture.ts`

Implementation TODOs:
- Decide whether the scenario is navigation-only or full booking.
- If navigation-only, convert it now with `selectedAction`, typed Calendly URL args, and `browserTaskCompleted`.
- If full booking is required, add a Calendly-specific browser-task bridge with lifecycle and provenance.

Acceptance criteria:
- The scenario name and assertions must match the implemented scope exactly.

## Workstream 5: Shared Gateway Routing

Owner: `Ohm`

Scenarios:
- `discord-gateway.bot-routes-to-user-agent`
- `telegram-gateway.bot-routes-to-user-agent`
- `whatsapp-gateway.bot-routes-to-user-agent`

Status:
- Discord: implemented path, missing hard assertions
- Telegram: real routing gap
- WhatsApp: real routing gap

Exact seams:
- `eliza/cloud/packages/lib/services/eliza-gateway-router.ts`
- `eliza/cloud/packages/lib/services/eliza-managed-discord.ts`
- `eliza/cloud/packages/services/gateway-discord/src/server-router.ts`
- `eliza/plugins/plugin-discord/typescript/service.ts`
- `eliza/plugins/plugin-telegram/src/service.ts`
- `eliza/plugins/plugin-whatsapp/typescript/src/runtime-service.ts`

Implementation TODOs:
- Convert the Discord scenario into a routing proof: correct target runtime, correct room/entity ownership, no cross-user leakage.
- Build or expose Telegram shared-gateway routing instead of pretending connector inbound implies per-user gateway ownership.
- Build or expose WhatsApp shared-gateway routing with the same target-runtime guarantees.

Acceptance criteria:
- A routed inbound message resolves to exactly one user agent and replies through the same connector.

## Workstream 6: Twilio Inbound And Billing

Owner: `Socrates`

Scenarios:
- `twilio.call.receive`
- `twilio.sms.receive-route-to-agent`
- `billing.20-percent-markup-applied`

Status:
- SMS receive: implemented path, missing scenario coverage
- inbound call: real runtime gap
- billing markup persistence: real runtime gap

Exact seams:
- `eliza/cloud/app/api/webhooks/twilio/[orgId]/route.ts`
- `eliza/cloud/app/api/v1/twilio/voice/inbound/route.ts`
- `eliza/cloud/packages/db/schemas/twilio-inbound-calls.ts`
- `eliza/cloud/packages/services/billing/src/markup.ts`
- `eliza/cloud/packages/services/gateway-webhook/src/adapters/twilio.ts`
- `eliza/cloud/packages/lib/services/usage.ts`
- `eliza/cloud/packages/db/schemas/usage-records.ts`
- `eliza/cloud/app/api/v1/admin/users/[userId]/billing/breakdown/route.ts`

Implementation TODOs:
- Convert the inbound SMS scenario into a webhook contract test with signature validation, dedupe, and real route-to-agent assertions.
- Add inbound voice-to-agent ownership if voice is meant to be a real assistant surface.
- Persist Twilio usage records so the 20 percent markup appears in billing breakdowns instead of existing only in in-memory math or logs.

Acceptance criteria:
- SMS: signed inbound webhook routes a real message into the agent once.
- Call: signed inbound voice request persists and hands off to a real voice flow.
- Billing: usage persistence exposes raw, markup, and billed totals in admin breakdowns.

## Workstream 7: BlueBubbles / iMessage

Owner: `Locke`

Scenarios:
- `bluebubbles.imessage.receive`
- `bluebubbles.imessage.send-blue`
- `imessage.cross-reference-contact`

Status:
- BlueBubbles receive: implemented path, missing hard assertions
- BlueBubbles send: implemented path, missing hard assertions
- iMessage cross-reference: partially supported, currently too loose

Exact seams:
- `eliza/packages/agent/src/api/bluebubbles-routes.ts`
- `eliza/plugins/plugin-bluebubbles/typescript/src/service.ts`
- `eliza/plugins/plugin-bluebubbles/typescript/src/actions/sendMessage.ts`
- `eliza/plugins/plugin-imessage/typescript/src/contacts-reader.ts`
- `eliza/packages/agent/src/actions/connector-resolver.ts`
- `eliza/packages/agent/src/actions/entity-actions.ts`
- `eliza/plugins/plugin-imessage/typescript/src/rpc.ts`

Implementation TODOs:
- Rewrite the receive scenario to require a real BlueBubbles webhook-to-memory path and a response grounded in the inbound content.
- Rewrite the send scenario to require two-step confirmation and `SEND_BLUEBUBBLES_MESSAGE`.
- Tighten the cross-reference scenario so it only passes on `SEARCH_ENTITY` or `READ_ENTITY` style contact resolution, not generic fallback tools.
- Decide whether to implement a dedicated iMessage contact lookup action or keep the scenario on generic entity search.

Acceptance criteria:
- Receive, send, and contact lookup all fail closed when the connector path is not actually exercised.

## Workstream 8: Goal Review And Experience Loop

Owner: `Dalton`

Scenarios:
- `goal.career.quarterly-review`
- `goal.experience-loop.learn-from-completion`
- `goal.experience-loop.weekly-review`

Status:
- quarterly review: only convertible if narrowed to current `review_goal` semantics
- experience loop learn-from-completion: real runtime gap
- experience loop weekly review: real runtime gap

Exact seams:
- `eliza/plugins/app-lifeops/src/actions/life.ts`
- `eliza/plugins/app-lifeops/src/lifeops/service-mixin-goals.ts`
- `eliza/plugins/app-lifeops/src/lifeops/goal-semantic-evaluator.ts`
- `eliza/plugins/app-lifeops/src/activity-profile/proactive-planner.ts`
- `eliza/plugins/app-lifeops/src/lifeops/checkin/checkin-service.ts`
- `eliza/plugins/app-lifeops/src/lifeops/checkin/types.ts`

Implementation TODOs:
- Decide whether `goal.career.quarterly-review` should remain a strict quarterly-review backlog item or be rewritten to current `review_goal`.
- If kept strict, do not convert it prematurely.
- Add an experience-loop reader for prior lessons / completed-goal learning before converting the learn-from-completion scenario.
- Add weekly review cadence support before converting the weekly-review scenario.

Acceptance criteria:
- Any goal-review scenario must assert structured review state, not generic motivational prose.

## Workstream 9: Progress, Habits, And Pause State

Owner: `Noether`

Scenarios:
- `goal.health.track-progress`
- `goal.relationship.track-progress`
- `habit.missed-streak.escalation`
- `habit.pause-while-traveling`

Status:
- health progress: stale scenario, convertible now against `review_goal`
- relationship progress: stale scenario, convertible now against `RELATIONSHIP`
- missed streak escalation: real runtime gap
- pause while traveling: real runtime gap

Exact seams:
- `eliza/packages/scenario-runner/src/seeds.ts`
- `eliza/plugins/app-lifeops/src/lifeops/health-bridge.ts`
- `eliza/plugins/app-lifeops/src/lifeops/service-mixin-goals.ts`
- `eliza/plugins/app-lifeops/src/actions/relationships.ts`
- `eliza/plugins/app-lifeops/src/lifeops/checkin/checkin-service.ts`
- `eliza/plugins/app-lifeops/src/lifeops/service-helpers-occurrence.ts`
- `eliza/plugins/app-lifeops/src/lifeops/service-mixin-definitions.ts`
- `eliza/plugins/app-lifeops/src/lifeops/repository.ts`
- `eliza/plugins/app-lifeops/src/lifeops/engine.ts`

Implementation TODOs:
- Rewrite `goal.health.track-progress` to assert structured `review_goal` output fields instead of ignored memory seeds.
- Rewrite `goal.relationship.track-progress` to assert `RELATIONSHIP` follow-up output, or remove it if the existing relationships scenario already covers the same path.
- Add habit streak state to morning check-in before converting the escalation scenario.
- Add time-bounded pause windows plus auto-resume before converting the travel-pause scenario.

Acceptance criteria:
- Goal progress scenarios must assert typed result fields.
- Habit scenarios must fail unless the engine exposes streak/pause state explicitly.

## Workstream 10: Messaging Controls And Cross-Platform Escalation

Owner: `Archimedes`

Scenarios:
- `cross-platform.escalation-to-user`
- `cross-platform.group-chat-gateway`
- `discord.local.mute-channel`
- `telegram.local.mute-chat`
- `twitter.dm.schedule-reply`

Status:
- cross-platform escalation: stale placeholder waiting on real gateway intent bus
- cross-platform group chat: stale placeholder waiting on real gateway intent bus
- Discord mute: real runtime coverage, missing hard assertions
- Telegram mute: real runtime gap
- X DM scheduled reply: real runtime gap or needs narrowing to existing draft behavior

Exact seams:
- `eliza/plugins/app-lifeops/src/actions/inbox.ts`
- `eliza/plugins/app-lifeops/src/actions/inbox.ts`
- `eliza/packages/agent/src/services/escalation.ts`
- `eliza/plugins/app-lifeops/src/actions/device-bus.ts`
- `eliza/packages/core/src/features/advanced-capabilities/actions/muteRoom.ts`
- `eliza/plugins/plugin-telegram/src/service.ts`
- `eliza/plugins/app-lifeops/src/lifeops/x-dm-reader.ts`
- `eliza/plugins/app-lifeops/src/actions/x-read.ts`
- `eliza/packages/agent/src/actions/send-message.ts`

Implementation TODOs:
- Keep the two cross-platform gateway scenarios quarantined until the intent bus and gateway orchestration really exist.
- Rewrite `discord.local.mute-channel` so it proves `MUTE_ROOM` and a mutated muted state.
- Add Telegram-specific mute/chat-control behavior before converting the Telegram scenario.
- Decide whether X DM scheduled reply is a real product requirement; if yes, implement queueing/scheduling, and if not, rename the scenario to current draft behavior.

Acceptance criteria:
- Messaging scenarios must prove connector-scoped state changes or connector-scoped outbound scheduling, not generic inbox fallback.

## Execution Order

### Phase 1: honest scenario conversions

- `lifeops-extension.see-what-user-sees`
- `twilio.sms.receive-route-to-agent`
- `bluebubbles.imessage.receive`
- `bluebubbles.imessage.send-blue`
- `discord-gateway.bot-routes-to-user-agent`
- `discord.local.mute-channel`
- `goal.health.track-progress`
- `goal.relationship.track-progress`
- `imessage.cross-reference-contact`
- `activity.context-aware-response` if narrowed to current screen focus
- `calendar.calendly.navigate` if narrowed to navigation-only

### Phase 2: shrink false-positive surfaces

- tighten `goal.career.quarterly-review` or leave it explicitly NYI
- quarantine the two cross-platform gateway placeholders unless the intent bus lands
- reject fallback success in `imessage.cross-reference-contact`, `telegram.local.mute-chat`, and `twitter.dm.schedule-reply`

### Phase 3: real runtime backlog

- weekly per-app averages
- calendar travel-time creation
- Telegram and WhatsApp shared gateway routing
- Twilio inbound voice handoff
- billing markup persistence
- experience-loop retrieval and weekly review cadence
- habit streak escalation and time-bounded pause windows
- Telegram local mute
- X DM scheduled replies

## Done Definition For This Closure Pass

- No scenario should pass by matching generic response text when a typed action/result exists.
- Placeholder scenarios stay explicitly quarantined until the runtime exists.
- Converted scenarios must assert selected action, typed arguments, or structured result payloads.
- Real runtime gaps remain in backlog with exact owning modules instead of hand-wavy NYI comments.
