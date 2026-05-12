# `action.ENTITY@plugins/app-lifeops/src/actions/entity.ts.param.channel.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-lifeops
- **File**: `plugins/app-lifeops/src/actions/entity.ts:447`
- **Token count**: 27
- **Last optimized**: never
- **Action**: ENTITY
- **Parameter**: channel (required: no)

## Current text
```
Primary channel for the contact (email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp).
```

## Compressed variant
```
primary channel: email|telegram|discord|signal|sms|twilio_voice|imessage|whatsapp
```

## Usage stats (latest trajectories)
- Invocations: 20
- Success rate: 0.80
- Avg input chars when matched: 43496

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
