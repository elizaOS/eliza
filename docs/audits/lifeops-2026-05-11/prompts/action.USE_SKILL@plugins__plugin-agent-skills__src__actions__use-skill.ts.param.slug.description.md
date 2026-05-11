# `action.USE_SKILL@plugins/plugin-agent-skills/src/actions/use-skill.ts.param.slug.description`

- **Kind**: action-parameter
- **Owner**: plugins/plugin-agent-skills
- **File**: `plugins/plugin-agent-skills/src/actions/use-skill.ts:228`
- **Token count**: 28
- **Last optimized**: never
- **Action**: USE_SKILL
- **Parameter**: slug (required: yes)

## Current text
```
Slug (canonical name) of an enabled skill to invoke. Must match a skill returned by the enabled_skills provider.
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
