# `action.REMOTE_DESKTOP@packages/prompts/specs/actions/plugins.generated.json.param.action.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 11
- **Last optimized**: never
- **Action**: REMOTE_DESKTOP
- **Parameter**: action (required: no)

## Current text
```
One of: start, status, end, list, revoke.
```

## Compressed variant
```
remote-desktop action: start|status|end|list|revoke
```

## Usage stats (latest trajectories)
- Invocations: 8
- Success rate: 0.50
- Avg input chars when matched: 47710

## Sample failure transcripts
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`
- traj `tj-ff0d32930f4070` scenario `shower-weekly-basic__childlike` status=errored stage=planner
  - user: `Can you help me with this please? Please remind me to shower three times a week.`

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
