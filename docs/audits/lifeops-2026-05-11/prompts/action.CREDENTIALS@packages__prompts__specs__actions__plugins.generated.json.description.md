# `action.CREDENTIALS@packages/prompts/specs/actions/plugins.generated.json.description`

- **Kind**: action-description
- **Owner**: spec-only
- **File**: `packages/prompts/specs/actions/plugins.generated.json`
- **Token count**: 36
- **Last optimized**: never
- **Action**: CREDENTIALS

## Current text
```
Owner-only password and autofill operations across browser autofill (LifeOps extension) and the OS password manager (1Password / ProtonPass). 
```

## Compressed variant
```
credentials: fill|whitelist_add|whitelist_list|search|list|inject_username|inject_password; clipboard-only; confirmed:true required for inject and whitelist_add
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
None.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
