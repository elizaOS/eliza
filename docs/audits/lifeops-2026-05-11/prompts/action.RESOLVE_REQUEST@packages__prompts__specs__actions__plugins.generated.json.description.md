# `action.RESOLVE_REQUEST@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 70
- **Last optimized**: never
- **Action**: RESOLVE_REQUEST
- **Similes**: APPROVE, REJECT, CONFIRM, DENY, YES_DO_IT, NO_DONT, ACCEPT_REQUEST, DECLINE_REQUEST, ADMIN_REJECT_APPROVAL, REJECT_APPROVAL, DENY_APPROVAL, DECLINE_APPROVAL

## Current text
```
Approve or reject a pending action queued for owner confirmation (send_email, send_message, book_travel, voice_call, etc.). Subactions: approve, reject. requestId is optional — the handler inspects the pending queue and infers the target from owner intent, or asks a follow-up.
```

## Compressed variant
```
approve|reject queued action; requestId optional; covers send_email|send_message|book_travel|voice_call
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (103 chars vs 277 chars — 63% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
