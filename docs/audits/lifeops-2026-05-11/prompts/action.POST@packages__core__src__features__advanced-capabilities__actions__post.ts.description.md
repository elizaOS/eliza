# `action.POST@packages/core/src/features/advanced-capabilities/actions/post.ts.description`

- **Kind**: action-description
- **Owner**: packages/core
- **File**: `packages/core/src/features/advanced-capabilities/actions/post.ts:650`
- **Token count**: 65
- **Last optimized**: never
- **Action**: POST
- **Similes**: TWEET, CAST, PUBLISH, FEED_POST, TIMELINE

## Current text
```
Primary action for public feed surfaces and timelines. Choose action=send to publish a post, action=read to fetch recent feed posts, or action=search to search public posts. Addressed DMs, groups, channels, rooms, and inbox/draft workflows belong to MESSAGE.
```

## Compressed variant
```
primary post action ops send read search public feed timeline posts
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (67 chars vs 258 chars — 74% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
