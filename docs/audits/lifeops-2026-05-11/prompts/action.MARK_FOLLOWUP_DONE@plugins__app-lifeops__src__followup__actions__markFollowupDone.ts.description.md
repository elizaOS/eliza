# `action.MARK_FOLLOWUP_DONE@plugins/app-lifeops/src/followup/actions/markFollowupDone.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/followup/actions/markFollowupDone.ts:64`
- **Token count**: 77
- **Last optimized**: never
- **Action**: MARK_FOLLOWUP_DONE
- **Similes**: FOLLOWED_UP, FOLLOWUP_DONE, CONTACTED, MARK_CONTACTED, RECORD_INTERACTION

## Current text
```
Mark a contact as already followed-up-with (updates lastContactedAt to now). Use this only when the interaction already happened, not for future reminders. Requires either an explicit contactId (UUID) or an unambiguous contactName. Ambiguous names return a clarifying response without modifying any contact.
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
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
