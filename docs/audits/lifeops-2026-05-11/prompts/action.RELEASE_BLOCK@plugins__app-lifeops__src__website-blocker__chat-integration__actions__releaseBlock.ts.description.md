# `action.RELEASE_BLOCK@plugins/app-lifeops/src/website-blocker/chat-integration/actions/releaseBlock.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/website-blocker/chat-integration/actions/releaseBlock.ts:110`
- **Token count**: 40
- **Last optimized**: never
- **Action**: RELEASE_BLOCK
- **Similes**: RELEASE_WEBSITE_BLOCK, END_BLOCK_RULE, BYPASS_BLOCK_RULE

## Current text
```
Release an active website block rule. Requires confirmed:true. harsh_no_bypass rules cannot be released via confirmation — they must wait for gate fulfillment.
```

## Compressed variant
```
Release a website block rule; requires confirmation.
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
