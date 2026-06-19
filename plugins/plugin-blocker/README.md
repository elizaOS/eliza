# @elizaos/plugin-blocker

Focus / distraction control for Eliza agents: website blocking via a
SelfControl-style hosts engine and macOS / mobile app blocking. Exposes
two providers (`websiteBlocker`, `appBlocker`),
`WebsiteBlockerService` + `AppBlockerService`, a drizzle `pgSchema('app_blocker')`,
and a `focus` overlay view for the dashboard shell.

## Status

This is the initial scaffold landed as part of decomposing the giant
`@elizaos/plugin-personal-assistant` into focused plugins. The plugin compiles standalone
and registers with the runtime; the providers / services are
intentional stubs that point at the live implementations still resident in
`plugin-lifeops`. The `BLOCK` umbrella action is still registered by the
personal-assistant plugin (its persistence couples to the lifeops SQL layer) and
is intentionally not registered here to avoid double-registration. The next pass
moves that code over and removes the lifeops copies.

## Migration mapping from `@elizaos/plugin-personal-assistant`

| New location (this plugin) | Source in `plugin-lifeops` |
|---|---|
| `src/actions/block.ts` (`blockAction`) | `plugins/plugin-personal-assistant/src/actions/block.ts` plus the per-target dispatchers `app-block.ts` and `website-block.ts` |
| `src/providers/website-blocker.ts` | `plugins/plugin-personal-assistant/src/providers/website-blocker.ts` |
| `src/providers/app-blocker.ts` | `plugins/plugin-personal-assistant/src/providers/app-blocker.ts` |
| `src/services/website-blocker.ts` (`WebsiteBlockerService`) | `plugins/plugin-personal-assistant/src/website-blocker/` (`engine.ts`, `service.ts`, `access.ts`, `permissions.ts`, `public.ts`, `proactive-block-bridge.ts`, `roles.ts`, `chat-integration/`) |
| `src/services/app-blocker.ts` (`AppBlockerService`) | `plugins/plugin-personal-assistant/src/app-blocker/` (`engine.ts`, `access.ts`, `types.ts`) |
| `src/db/schema.ts` (`pgSchema('app_blocker')`) | new — there was no drizzle table in lifeops; previous state lived in disk-backed engine files. The new schema gives the migrated services a persistent store and lets the runtime own migrations through `@elizaos/plugin-sql`. |
| `src/components/focus/FocusView.tsx` | new — no equivalent existed in plugin-lifeops; this is the dashboard view for the extracted plugin. |

## Surface

### Providers
- `websiteBlocker` — active website block sessions and override state.
- `appBlocker` — active app block sessions and override state.

Both gate to `contexts: ["focus", "automation"]`.

### Services
- `WebsiteBlockerService` (`serviceType = "website-blocker"`)
- `AppBlockerService` (`serviceType = "app-blocker"`)

### Schema
- `pgSchema('app_blocker')` with tables:
  - `block_rules` — host or bundle id rules per `(agentId, entityId)`.
  - `active_sessions` — running block sessions with end timestamps.
  - `allow_list` — exempted hosts / bundle ids per `(agentId, entityId)`.

### View
- `focus` — path `/focus`, component `FocusView`, bundled to
  `dist/views/bundle.js` by `vite.config.views.ts`.

### Action (not yet registered)
- `BLOCK` (`src/actions/block.ts`) — stub; target/subaction matrix exists but
  the action is not yet added to the plugin object. It is currently registered
  by `@elizaos/plugin-personal-assistant`.

## Commands

```bash
bun run --cwd plugins/plugin-blocker typecheck   # tsc --noEmit
bun run --cwd plugins/plugin-blocker lint        # biome check src/
bun run --cwd plugins/plugin-blocker test        # vitest run
bun run --cwd plugins/plugin-blocker build       # build:js + build:views + build:types
bun run --cwd plugins/plugin-blocker clean       # rm -rf dist
```

## Conventions

- Hard-depends on `@elizaos/plugin-sql` for migrations and `runtime.db`.
- Services log with the `[Blocker]` prefix.
- Two providers, one schema — the same shape as the other
  decomposed lifeops plugins.
- See the root `AGENTS.md` for repo-wide architecture rules.
