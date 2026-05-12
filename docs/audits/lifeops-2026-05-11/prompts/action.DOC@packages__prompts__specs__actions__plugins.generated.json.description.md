# `action.DOC@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 65
- **Last optimized**: never
- **Action**: DOC

## Current text
```
Manage the owner's document workflow surface: signature requests, approvals, deadline tracking, portal uploads, ID/form collection, and request close-out. Subactions: request_signature, request_approval, track_deadline, upload_asset, collect_id, close_request.
```

## Compressed variant
```
docs: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request; deadline-aware; owner-gated for signature+upload
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (143 chars vs 260 chars — 45% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
