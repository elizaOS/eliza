# `action.USE_SKILL@plugins/plugin-agent-skills/src/actions/use-skill.ts.param.mode.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-agent-skills
- **File**: `plugins/plugin-agent-skills/src/actions/use-skill.ts:228`
- **Token count**: 46
- **Last optimized**: never
- **Action**: USE_SKILL
- **Parameter**: mode (required: no)

## Current text
```
How to invoke the skill: 'script' to run the bundled executable, 'guidance' to load the SKILL.md instructions, or 'auto' to pick automatically based on whether the skill ships scripts.
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
