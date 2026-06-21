# @elizaos/plugin-blocker

Focus / distraction control for Eliza agents: website blocking via a
SelfControl-style hosts engine and macOS / mobile app blocking. Exposes
two providers (`websiteBlocker`, `appBlocker`),
`WebsiteBlockerService` + `AppBlockerService`, a drizzle `pgSchema('app_blocker')`,
and a `focus` overlay view for the dashboard shell.

## Status

This plugin owns the focus/blocking platform, schema, providers, services, and
view. The `BLOCK` umbrella action is still registered by
`@elizaos/plugin-personal-assistant` because its owner gating, scheduler hooks,
and chat-oriented dispatch flow remain PA-resident. It is intentionally not
registered or exported here to avoid duplicate action registration.

## Migration mapping from `@elizaos/plugin-personal-assistant`

| New location (this plugin) | Source in `@elizaos/plugin-personal-assistant` |
|---|---|
| `src/providers/website-blocker.ts` | `plugins/plugin-personal-assistant/src/providers/website-blocker.ts` |
| `src/providers/app-blocker.ts` | `plugins/plugin-personal-assistant/src/providers/app-blocker.ts` |
| `src/services/website-blocker.ts` (`WebsiteBlockerService`) | `plugins/plugin-personal-assistant/src/website-blocker/` (`engine.ts`, `service.ts`, `access.ts`, `permissions.ts`, `public.ts`, `proactive-block-bridge.ts`, `roles.ts`, `chat-integration/`) |
| `src/services/app-blocker.ts` (`AppBlockerService`) | `plugins/plugin-personal-assistant/src/app-blocker/` (`engine.ts`, `access.ts`, `types.ts`) |
| `src/db/schema.ts` (`pgSchema('app_blocker')`) | new — there was no previous drizzle table; state lived in disk-backed engine files. The schema gives the services a persistent store and lets the runtime own migrations through `@elizaos/plugin-sql`. |
| `src/components/focus/FocusView.tsx` | new dashboard view for the extracted plugin. |

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

### Action
- None registered here. `BLOCK` is host-adapted by
  `@elizaos/plugin-personal-assistant`.

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
