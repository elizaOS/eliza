# __PLUGIN_DISPLAY_NAME__

Scaffolded from `packages/elizaos/templates/min-plugin`. This is a minimal Eliza runtime plugin: one provider, no UI.

The scaffold copy step replaces these placeholders:

- `__PLUGIN_NAME__` → npm-style package name (e.g. `@elizaos/plugin-foo`)
- `__PLUGIN_DISPLAY_NAME__` → human-readable display name

Read `SCAFFOLD.md` for the full agent instructions before editing.

## Scripts

```bash
bun run typecheck  # tsc --noEmit
bun run lint       # biome check (skipped if not configured)
bun run test       # vitest run
```
