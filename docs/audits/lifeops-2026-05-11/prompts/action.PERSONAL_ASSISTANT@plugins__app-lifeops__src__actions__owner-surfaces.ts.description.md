# `action.PERSONAL_ASSISTANT@plugins/app-lifeops/src/actions/owner-surfaces.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/owner-surfaces.ts:565`
- **Token count**: 56
- **Last optimized**: never
- **Action**: PERSONAL_ASSISTANT
- **Similes**: ASSISTANT, BOOK_TRAVEL, SCHEDULING, SCHEDULING_NEGOTIATION, SIGN_DOCUMENT, DOCUSIGN, TRAVEL_CAPTURE_PREFERENCES, TRAVEL_BOOK_FLIGHT, TRAVEL_BOOK_HOTEL, TRAVEL_SYNC_ITINERARY_TO_CALENDAR, TRAVEL_REBOOK_AFTER_CONFLICT

## Current text
```
Owner personal-assistant workflows. Use action=book_travel for real travel booking, action=scheduling for scheduling negotiation, and action=sign_document for document-signature flows that must be queued for owner approval.
```

## Compressed variant
```
personal assistant workflows: action=book_travel|scheduling|sign_document
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (73 chars vs 223 chars — 67% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
