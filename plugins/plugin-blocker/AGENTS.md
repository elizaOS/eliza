# @elizaos/plugin-blocker

Focus / distraction control for Eliza agents — website blocking via a
SelfControl-style hosts engine and macOS / mobile app blocking.

## Purpose / role

Provides the focus surface for an Eliza agent: a single `BLOCK` umbrella action
(target = app | website), two read-only providers that surface the user's
current block state, and two Service classes that own the platform engine
lifecycle. Persistence lives in a drizzle `pgSchema('app_blocker')`. Ships a
`focus` overlay view rendered by the dashboard shell.

This package was scaffolded as part of decomposing the giant
`@elizaos/plugin-lifeops`. The action / providers / services are currently
stubs that reference the live implementations still in `plugin-lifeops`. See
`README.md` for the migration mapping.

## Plugin surface

### Action
- `BLOCK` (`src/actions/block.ts`) — umbrella with `target` and `action`
  parameters. Matrix:
  - `app`: `block`, `unblock`, `status`
  - `website`: `block`, `unblock`, `status`, `request_permission`, `release`,
    `list_active`
  - Contexts: `focus`, `automation`. Role gate: ADMIN.

### Providers
- `WEBSITE_BLOCKER` (`src/providers/website-blocker.ts`) — active website block
  sessions and override state. Position `-3`, contexts `focus` / `automation`.
- `APP_BLOCKER` (`src/providers/app-blocker.ts`) — active app block sessions.

### Services
- `WebsiteBlockerService` (`src/services/website-blocker.ts`,
  `serviceType = "website-blocker"`).
- `AppBlockerService` (`src/services/app-blocker.ts`,
  `serviceType = "app-blocker"`).

### Schema
- `pgSchema('app_blocker')` (`src/db/schema.ts`) — tables `block_rules`,
  `active_sessions`, `allow_list`.

### View
- `focus` — `FocusView` component, path `/focus`, bundle
  `dist/views/bundle.js`, icon `ShieldOff`.

## Layout

```
src/
  plugin.ts                       blockerPlugin definition
  index.ts                        Public export barrel
  types.ts                        Constants + Block* types
  actions/
    block.ts                      BLOCK umbrella action (stub)
  providers/
    website-blocker.ts            WEBSITE_BLOCKER provider (stub)
    app-blocker.ts                APP_BLOCKER provider (stub)
  services/
    website-blocker.ts            WebsiteBlockerService (stub)
    app-blocker.ts                AppBlockerService (stub)
  db/
    index.ts                      Re-exports schema
    schema.ts                     pgSchema('app_blocker') + tables
  components/
    focus/
      FocusView.tsx               Schedule + active-session overlay view
      focus-view-bundle.ts        Vite view bundle entry
```

## Commands

```bash
bun run --cwd plugins/plugin-blocker typecheck    # tsc --noEmit -p tsconfig.json
bun run --cwd plugins/plugin-blocker lint         # biome check src/
bun run --cwd plugins/plugin-blocker test         # vitest run
bun run --cwd plugins/plugin-blocker build        # build:js + build:views + build:types
bun run --cwd plugins/plugin-blocker build:js     # tsup
bun run --cwd plugins/plugin-blocker build:views  # vite — focus view bundle
bun run --cwd plugins/plugin-blocker build:types  # tsc declarations
bun run --cwd plugins/plugin-blocker clean        # rm -rf dist
```

## Config / env vars

This plugin reads no environment variables and has no settings keys yet. Once
the real services are migrated, the SelfControl admin permission flow and the
macOS app-blocker bundle-id allow-list will pick up the same env contract as
the lifeops implementations they replace.

## How to extend

- **Add a Service method:** add to `WebsiteBlockerService` / `AppBlockerService`
  in `src/services/`. Use `this.runtime.db` (typed via drizzle) once schema
  tables are wired through.
- **Add a provider:** create `src/providers/<name>.ts` and add to the
  `providers` array in `src/plugin.ts`.
- **Add a view:** add a component under `src/components/`, re-export from the
  view bundle entry, add a view declaration in `src/plugin.ts` `views`.

## Conventions / gotchas

- Stubs reference the source in plugin-lifeops via TODO(migration) comments —
  preserve those when porting; they are the only breadcrumbs.
- `@elizaos/plugin-sql` is required at runtime — schema registration in the
  Plugin object tells the SQL plugin to migrate `app_blocker`.
- The view bundle is built independently of the JS / type build (`build:views`
  vs `build:js` + `build:types`) — both must run for a complete release.
- All services log with the `[Blocker]` prefix.
- See the root `AGENTS.md` for repo-wide architecture rules, logger
  conventions, and ESM standards.
