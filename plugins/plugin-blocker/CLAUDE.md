# @elizaos/plugin-blocker

Focus / distraction control for Eliza agents — website blocking via a
SelfControl-style hosts engine and macOS / mobile app blocking.

## Purpose / role

Provides the focus surface for an Eliza agent: two read-only providers that
surface the user's current block state, two Service classes that own the
platform engine lifecycle, a drizzle `pgSchema('app_blocker')`, and a `focus`
overlay view rendered by the dashboard shell. The `BLOCK` umbrella action is
host-adapted by `@elizaos/plugin-personal-assistant`.

This package owns the providers, services, schema, and view. The `BLOCK` action
remains in `@elizaos/plugin-personal-assistant` so owner gating, scheduler
integration, and chat dispatch have one owner.

## Plugin surface

### Actions
- None registered here. `BLOCK` is registered by
  `@elizaos/plugin-personal-assistant`.

### Providers
- `WEBSITE_BLOCKER` (`src/providers/website-blocker.ts`) — active website block
  sessions and override state. Position `-3`, contexts `focus` / `automation`.
- `APP_BLOCKER` (`src/providers/app-blocker.ts`) — active app block sessions.

### Services
- `WebsiteBlockerService` (`src/services/website-blocker/service.ts`,
  `serviceType = "website_blocker"`).
- `AppBlockerService` (`src/services/app-blocker/service.ts`,
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
  providers/
    website-blocker.ts            WEBSITE_BLOCKER provider
    app-blocker.ts                APP_BLOCKER provider
  services/
    website-blocker/              hosts/native engine, permissions, service
    app-blocker/                  platform access, engine, service, types
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

`WEBSITE_BLOCKER_HOSTS_FILE_PATH` overrides the hosts file used by the website
engine; `SELFCONTROL_HOSTS_FILE_PATH` is the compatibility alias. Platform
access and permission state are otherwise resolved through the native service
boundaries.

## How to extend

- **Add a Service method:** add to `WebsiteBlockerService` / `AppBlockerService`
  in `src/services/`. Use `this.runtime.db` (typed via drizzle) once schema
  tables are wired through.
- **Add a provider:** create `src/providers/<name>.ts` and add to the
  `providers` array in `src/plugin.ts`.
- **Add a view:** add a component under `src/components/`, re-export from the
  view bundle entry, add a view declaration in `src/plugin.ts` `views`.

## Conventions / gotchas

- Do not add a second `BLOCK` action here unless the PA-hosted owner gating,
  scheduler hooks, and chat dispatch behavior move with parity tests.
- `@elizaos/plugin-sql` is required at runtime — schema registration in the
  Plugin object tells the SQL plugin to migrate `app_blocker`.
- The view bundle is built independently of the JS / type build (`build:views`
  vs `build:js` + `build:types`) — both must run for a complete release.
- All services log with the `[Blocker]` prefix.
- See the root `CLAUDE.md` for repo-wide architecture rules, logger
  conventions, and ESM standards.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
