# `action.PLAY_EMOTE@plugins/app-companion/src/actions/emote.ts.param.emote.description`

- **Kind**: action-parameter
- **Owner**: plugins/app-companion
- **File**: `plugins/app-companion/src/actions/emote.ts:21`
- **Token count**: 52
- **Last optimized**: never
- **Action**: PLAY_EMOTE
- **Parameter**: emote (required: yes)

## Current text
```
Required emote ID to play once silently before returning to idle. Common mappings: dance/vibe → dance-happy, wave/greet → wave, flip/backflip → flip, cry/sad → crying, fight/punch → punching, fish → fishing
```

## Compressed variant
```
none
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- No compressed variant. Authors should add `descriptionCompressed` — the planner caches both shapes and falls back to the long form when the compressed one is absent.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
