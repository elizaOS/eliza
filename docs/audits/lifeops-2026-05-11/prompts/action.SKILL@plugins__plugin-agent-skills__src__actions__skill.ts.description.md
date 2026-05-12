# `action.SKILL@plugins/plugin-agent-skills/src/actions/skill.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-agent-skills
- **File**: `plugins/plugin-agent-skills/src/actions/skill.ts:130`
- **Token count**: 78
- **Last optimized**: never
- **Action**: SKILL
- **Similes**: MANAGE_SKILL, MANAGE_SKILLS, SKILL_CATALOG, SKILLS, AGENT_SKILL, AGENT_SKILLS, INSTALL_SKILL, UNINSTALL_SKILL, SEARCH_SKILLS, SYNC_SKILL_CATALOG, TOGGLE_SKILL

## Current text
```
Manage skill catalog. Operations: search (browse available skills), details (info about a specific skill), sync (refresh catalog from registry), toggle (enable/disable installed skill), install (install from registry), uninstall (remove non-bundled skill). For invoking an enabled skill, use USE_SKILL instead.
```

## Compressed variant
```
Skill catalog: search, details, sync, toggle, install, uninstall.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (65 chars vs 310 chars — 79% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
