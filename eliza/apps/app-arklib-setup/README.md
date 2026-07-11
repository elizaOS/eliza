# Arklib Setup

Generated from `packages/elizaos/templates/min-project`. This is a minimal Eliza app: a Vite + React UI plus a starter runtime `Plugin`.

The template copy step replaces these tokens:

- `arklib-setup` → npm-style package name (e.g. `@elizaos/app-foo` or `@user/foo-app`)
- `Arklib Setup` → human-readable display name shown in the dashboard

Read `SCAFFOLD.md` for the full agent instructions before editing.

## Scripts

```bash
bun run dev        # Vite dev server
bun run build      # production bundle
bun run typecheck  # tsc --noEmit
bun run lint       # biome check (skipped if not configured)
bun run test       # vitest run
```
