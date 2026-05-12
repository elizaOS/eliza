# `action.PROPOSE_MEETING_TIMES@plugins/app-lifeops/src/actions/lib/scheduling-handler.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:463`
- **Token count**: 306
- **Last optimized**: never
- **Action**: PROPOSE_MEETING_TIMES
- **Similes**: SUGGEST_MEETING_TIMES, OFFER_MEETING_SLOTS, FIND_MEETING_SLOTS, PROPOSE_SLOTS, BUNDLE_MEETINGS_WHILE_TRAVELING, BULK_RESCHEDULE_MEETINGS, RESCHEDULE_MEETINGS

## Current text
```
Propose concrete meeting time slots to offer to another person. This is the dedicated action for any 'propose N times', 'suggest N slots', 'offer three times', 'find me three slots', 'give me a few times' request targeted at another person or team. It reads the owner's calendar busy times and meeting preferences (preferred hours, blackout windows, travel buffer) and returns three available slots by default over the next seven days. Also correct for bundled scheduling while traveling or concrete reschedule options. STRONG POSITIVE TRIGGERS — route HERE, not to CALENDAR or SCHEDULING_NEGOTIATION: 'propose three times for a sync with a person', 'suggest a few times for a partner', 'offer a colleague three 30-minute slots', 'find us three options next week', 'give me slots to send to a teammate'. DO NOT use this for small talk, weather, or vague conversation. DO NOT use this to check the owner's calendar, create a calendar event, or view upcoming events — that is CALENDAR. DO NOT use this to start a multi-turn scheduling negotiation record — that is SCHEDULING_NEGOTIATION (subaction: start). This action just generates the candidate slots; SCHEDULING_NEGOTIATION tracks the negotiation lifecycle around them.
```

## Compressed variant
```
Propose available meeting slots from the owner's calendar and meeting preferences; not calendar CRUD or negotiation tracking.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (125 chars vs 1221 chars — 90% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
