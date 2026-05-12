# `action.GOOGLE_CALENDAR@plugins/app-lifeops/src/actions/lib/calendar-handler.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/lib/calendar-handler.ts:3071`
- **Token count**: 402
- **Last optimized**: never
- **Action**: GOOGLE_CALENDAR
- **Similes**: CALENDAR_ACTION, CHECK_CALENDAR, CALENDAR_READ, CALENDAR_FEED, CALENDAR_NEXT_EVENT, CALENDAR_CREATE_EVENT, CALENDAR_SEARCH_EVENTS, SHOW_CALENDAR_TODAY, TODAY_SCHEDULE, WEEK_AHEAD, WEEK_VIEW, WHATS_MY_NEXT_MEETING, SCHEDULE_EVENT, CREATE_CALENDAR_EVENT, SEARCH_CALENDAR, NEXT_MEETING, ITINERARY, TRAVEL_SCHEDULE, CHECK_SCHEDULE, BOOK_TIME_BLOCK, RECURRING_TIME_BLOCK, REBOOK_TRAVEL

## Current text
```
Interact with live calendars through LifeOps. USE this action for: viewing today's or this week's schedule; checking the next upcoming event; searching events by title, attendee, location, or date range; creating new calendar events; requests like 'what's my next meeting?', 'show me my calendar for today', 'what does my week look like?', or 'schedule a dentist appointment next Tuesday at 3pm'; querying travel itineraries, flights, hotel stays, trip windows, reserving recurring time blocks, and rebooking or moving calendar-backed commitments. These are live calendar reads and writes, so do not answer them from provider context alone and do not fall back to NONE or REPLY when this action is available. DO NOT use this action when the user is only making an observation like 'my calendar has been crazy this quarter' unless they actually ask you to inspect or change calendar state. DO NOT use this action for email inbox work, drafting or sending emails — use MESSAGE with operation=triage, search_inbox, draft_reply, or send_draft (source=gmail for Gmail-specific work) instead. DO NOT use this action for personal habits, goals, routines, or reminders — use LIFE instead. DO NOT use this action to propose or suggest candidate meeting times to send to someone — use PROPOSE_MEETING_TIMES for requests like 'propose three times for a 30 min sync with X', 'suggest meeting slots', or 'find times that work next week'. The create_event subaction is only for booking a single known time on your own calendar. This action provides the final grounded reply; do not pair it with a speculative REPLY action.
```

## Compressed variant
```
Calendar via LifeOps: view schedule, search events, create events, query travel. Not for email or habits.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (105 chars vs 1608 chars — 93% shorter). Consider promoting it when planner cache pressure is high.
- Repeated phrase: `do not use this action` — appears more than once; consider deduping for token savings.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
