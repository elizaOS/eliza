# `action.PAGE_DELEGATE@packages/agent/src/actions/page-action-groups.ts.description`

- **Kind**: action-description
- **Owner**: packages/agent
- **File**: `packages/agent/src/actions/page-action-groups.ts:203`
- **Token count**: 67
- **Last optimized**: never
- **Action**: PAGE_DELEGATE
- **Similes**: PAGE_ACTIONS, BROWSER_TOOLS, WALLET_TOOLS, CHARACTER_TOOLS, SETTINGS_TOOLS, CONNECTOR_TOOLS, AUTOMATION_TOOLS, PHONE_TOOLS, OWNER_TOOLS, PERSONAL_ASSISTANT_ACTIONS

## Current text
```
Owner-only main-chat parent action. Routes a request to a child action under one of the page contexts (${PAGE_KEYS.join(", ")}). Call shape: { page: "<PAGE>", action: "<CHILD_NAME>", ...child fields }. The child action's parameter names go at the top level alongside \
```

## Compressed variant
```
PAGE_DELEGATE: owner-only parent; { page: <browser|wallet|character|settings|connectors|automation|phone|owner>, action: <CHILD>, ...child fields }.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (148 chars vs 268 chars — 45% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
