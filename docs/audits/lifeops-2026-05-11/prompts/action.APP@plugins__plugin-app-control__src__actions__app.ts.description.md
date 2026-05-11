# `action.APP@plugins/plugin-app-control/src/actions/app.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-app-control
- **File**: `plugins/plugin-app-control/src/actions/app.ts:153`
- **Token count**: 111
- **Last optimized**: never
- **Action**: APP
- **Similes**: APP_CONTROL, MANAGE_APPS

## Current text
```
Unified app control. action=launch starts a registered app; action=relaunch stops then launches (optionally with verify); action=list shows installed + running apps; action=load_from_directory registers apps from an absolute folder; action=create runs the multi-turn create-or-edit flow that searches existing apps, asks new/edit/cancel, scaffolds from the min-app template, and dispatches a coding agent with AppVerificationService validator.
```

## Compressed variant
```
Manage apps: launch/relaunch/list/load folder/create; create scaffolds min app, runs coding agent, verifies result.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (115 chars vs 443 chars — 74% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
