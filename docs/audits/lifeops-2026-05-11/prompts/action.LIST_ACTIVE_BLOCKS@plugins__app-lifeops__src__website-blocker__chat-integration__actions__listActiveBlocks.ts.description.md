# `action.LIST_ACTIVE_BLOCKS@plugins/app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocks.ts.description`

- **Kind**: action-description
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocks.ts:55`
- **Token count**: 130
- **Last optimized**: never
- **Action**: LIST_ACTIVE_BLOCKS
- **Similes**: LIST_BLOCK_RULES, SHOW_ACTIVE_BLOCKS, WEBSITE_BLOCKS_STATUS

## Current text
```
Report the current website blocker state by combining the live OS-level hosts/SelfControl status (active hosts, end time, permission notes) with LifeOps-managed block rules (id, gateType, websites, and gate target: todo id, ISO deadline, or fixed duration). Toggle either source via includeLiveStatus and includeManagedRules. Use only for website/app blocking status; do not use for inbox blockers, message priority, morning/night briefs, operating pictures, end-of-day reviews, or general executive-assistant triage.
```

## Compressed variant
```
list-website-blocks: live hosts/SelfControl status + managed rules (gateType, target, websites)
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (95 chars vs 517 chars — 82% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
