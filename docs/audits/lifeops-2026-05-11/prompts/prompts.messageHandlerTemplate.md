# `prompts.messageHandlerTemplate`

- **Kind**: template
- **Owner**: packages/prompts
- **File**: `packages/prompts/src/index.ts:659`
- **Token count**: 1628
- **Last optimized**: never

## Current text
```
task: {{#if directMessage}}Decide the plan for this direct message{{else}}Decide shouldRespond and the plan for this message{{/if}}.

available_contexts:
{{availableContexts}}

{{#if directMessage}}- this is a direct message; shouldRespond is hardcoded to RESPOND
- do not include shouldRespond; only write replyText, contexts, and thought
{{else}}shouldRespond:
- RESPOND: agent should answer or do work
- IGNORE: skip this message
- STOP: user asked agent to disengage
{{/if}}
replyText: the user-facing reply text. Always write it. On the simple path it is the whole answer; on the planning path it is a brief acknowledgement and the planner produces the final message.

contexts (directly after replyText): list of ids drawn from available_contexts (calendar, email, ...). Never invent ids. ["simple"] or [] = direct reply, no planner.

requiresTool=true when message needs tools/actions/subagents/providers/filesystem/network/browser/API/live data/side effects/long work/verification. Otherwise false.

simple shortcut — choose contexts=["simple"] only when ALL hold:
- purely conversational, greeting, or factual question answerable from training
- no external data, state, person, document, file, schedule, calendar, email, memory, or provider mentioned or implied
- no action verbs (search/find/get/fetch/save/send/create/update/delete/run/execute/call)
- answer would not change if checked against up-to-date info, world state, or memory
- when uncertain: prefer planning over simple

A platform mention, reply target, channel, room, or connector context alone does NOT disqualify simple — use simple when only a direct conversational reply is needed.

Never choose simple when the message:
- needs any tool/action/subagent/provider/filesystem/network/API/live data/side effect/verification
- names a person, place, file, document, data source, or asks about schedules or past interactions ("what did I say earlier", "what's on my calendar", "how many X")
- searches, browses, looks up current facts; runs shell commands; inspects files/logs/repos/services/disk; builds or deploys apps; creates PRs; spawns coding/task agents; sends messages; schedules tasks
- would benefit from a tool call even if the agent could fabricate a plausible answer
- is owner life-management (todos/habits/routines/goals/reminders/alarms/check-ins/blocks/calls/travel/device delivery/desktop actions/approvals) — route to the owning context so its action can ask any missing detail
- changes/persists/updates/remembers agent or user settings, preferences, identity, persona, response style, or future behavior — select settings (and any relevant context)

Domain routing (when context is available):
- morning/night/daily check-ins -> tasks; only include automation if user asks to schedule/change cadence
- relationship cadence ("follow up with David", "last talked to Alice", "how long since I spoke with Sam") -> contacts; one-off dated todos to call/text -> tasks
- explicit phone/call/dial a third party -> phone + contacts; do NOT include calendar just because the call is about an appointment
- device-targeted or broadcast reminders ("to my phone", "all devices", "broadcast") -> automation + connectors (not simple chat); tasks may be secondary
- owner password/saved-login lookup ("look up my GitHub password") -> settings + secrets so PASSWORD_MANAGER handles it; never answer with the raw secret in Stage 1
- website/social-site focus blocking -> automation + settings; app blocking -> automation + settings (not screen_time unless reporting)
- real flight/hotel/trip booking -> browser + calendar + payments + tasks so BOOK_TRAVEL owns the workflow
- Calendly availability + single-use booking links -> calendar + connectors, even when the message contains a Calendly API URL
- health/wearable reads (steps/sleep/heart rate/workouts) -> health
- X/Twitter DMs -> messaging + connectors; X/Twitter timeline/feed/mentions/post search -> social_posting + connectors (not generic web browsing)
- desktop/native-app/browser/Finder/window screenshots or control -> browser or automation (not media alone)
- LifeOps browser bridge/companion/extension/tab/settings -> browser; settings/connectors as secondary when configuration/connection state is asked
- durable owner facts and stable personal preferences, especially travel/booking preferences ("remember that I prefer aisle seats", "save my hotel preferences") -> memory; add PROFILE as a parent action hint when possible; do not route these to documents unless the user explicitly asks to create/search/edit a document or file

Otherwise: list every relevant context id; planning will run and tools will be selected from those contexts. If only general is available and a tool is still needed, use contexts=["general"].

Optional fields:
- candidateActions: up to 12 action-like retrieval hints inferred from the request ("send_email", "calendar_create_event", "search_documents", "play_music"). Speculative BM25/regex hints, not tool calls.
- parentActionHints: up to 6 parent action names only when explicit or highly likely. Omit over guess.
- contextSlices: up to 12 stable retrieval slice ids visible in the provided context. Never invent slice ids.

thought is internal rationale, not shown to user.

extract is OPTIONAL. Populate ONLY when the user states a durable fact about themselves, a person they know, or a relationship.
- worth extracting: "my birthday is March 5", "Alice is my manager", "I live in Brooklyn"
- skip: questions, requests, ephemeral state, agent self-talk, anything obvious from agent persona
- extract.facts: short factual statements in the user's voice ("the user's birthday is 1990-03-05"), under ~120 chars each, self-contained
- extract.relationships: subject-predicate-object triples; short entity names ("user", "Alice", "Acme Corp"); snake_case predicate ("works_with", "lives_in", "manages")
- extract.addressedTo: OPTIONAL entity UUIDs (preferred) or participant names this message is directed at. Agent's id/name when user talks to the agent; another participant's id/name when addressed by name or @-mention. Empty/omit when broadcast or unclear. Do not guess.
- omit extract entirely when nothing durable was stated and no addressee identified. Never invent.

Call {{handleResponseToolName}} exactly once with the envelope. Do not answer in plain text.

return:
Use the {{handleResponseToolName}} tool. Do not return JSON as message text.

JSON only. Return one JSON object. No prose, fences, thinking, or markdown.

```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
