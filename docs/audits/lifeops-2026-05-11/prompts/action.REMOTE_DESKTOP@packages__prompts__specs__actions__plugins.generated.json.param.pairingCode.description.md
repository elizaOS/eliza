# `action.REMOTE_DESKTOP@packages/prompts/specs/actions/plugins.generated.json.param.pairingCode.description`

- **Kind**: action-parameter
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 21
- **Last optimized**: never
- **Action**: REMOTE_DESKTOP
- **Parameter**: pairingCode (required: no)

## Current text
```
6-digit one-time pairing code for start. Required unless ELIZA_REMOTE_LOCAL_MODE=1.
```

## Compressed variant
```
6-digit pairing code (start; skipped in local mode)
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
