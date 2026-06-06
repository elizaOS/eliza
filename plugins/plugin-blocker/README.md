# @elizaos/plugin-blocker

Focus / distraction control for Eliza agents: website blocking via a
SelfControl-style hosts engine and macOS / mobile app blocking. Exposes the
`BLOCK` umbrella action, two providers (`WEBSITE_BLOCKER`, `APP_BLOCKER`),
`WebsiteBlockerService` + `AppBlockerService`, a drizzle `pgSchema('app_blocker')`,
and a `focus` overlay view for the dashboard shell.

## Status

This is the initial scaffold landed as part of decomposing the giant
`@elizaos/plugin-lifeops` into focused plugins. The plugin compiles standalone
and registers with the runtime; the action / providers / services are
intentional stubs that point at the live implementations still resident in
`plugin-lifeops`. The next pass moves that code over and removes the lifeops
copies.

## Migration mapping from `@elizaos/plugin-lifeops`

| New location (this plugin) | Source in `plugin-lifeops` |
|---|---|
| `src/actions/block.ts` (`blockAction`) | `plugins/plugin-lifeops/src/actions/block.ts` plus the per-target dispatchers `app-block.ts` and `website-block.ts` |
| `src/providers/website-blocker.ts` | `plugins/plugin-lifeops/src/providers/website-blocker.ts` |
| `src/providers/app-blocker.ts` | `plugins/plugin-lifeops/src/providers/app-blocker.ts` |
| `src/services/website-blocker.ts` (`WebsiteBlockerService`) | `plugins/plugin-lifeops/src/website-blocker/` (`engine.ts`, `service.ts`, `access.ts`, `permissions.ts`, `public.ts`, `proactive-block-bridge.ts`, `roles.ts`, `chat-integration/`) |
| `src/services/app-blocker.ts` (`AppBlockerService`) | `plugins/plugin-lifeops/src/app-blocker/` (`engine.ts`, `access.ts`, `types.ts`) |
| `src/db/schema.ts` (`pgSchema('app_blocker')`) | new — there was no drizzle table in lifeops; previous state lived in disk-backed engine files. The new schema gives the migrated services a persistent store and lets the runtime own migrations through `@elizaos/plugin-sql`. |
| `src/components/focus/FocusView.tsx` | new — no equivalent existed in plugin-lifeops; this is the dashboard view for the extracted plugin. |

## Surface

### Action
- `BLOCK` — target/subaction matrix:
  - `app`: `block`, `unblock`, `status`
  - `website`: `block`, `unblock`, `status`, `request_permission`, `release`, `list_active`

### Providers
- `WEBSITE_BLOCKER` — active website block sessions and override state.
- `APP_BLOCKER` — active app block sessions and override state.

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
- Two providers, one schema, one umbrella action — the same shape as the other
  decomposed lifeops plugins.
- See the root `AGENTS.md` for repo-wide architecture rules.
