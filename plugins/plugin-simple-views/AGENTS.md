# @elizaos/plugin-simple-views

Developer-only Notes and Simple Calendar views for exercising agent-driven view
navigation and interaction without depending on production personal-data
plugins.

## Role

This package owns two deliberately small app surfaces:

- `notes` — sticky-note CRUD with title, body, and color.
- `simple-calendar` — local event CRUD, month navigation, and selected date.

The package is opt-in through `ELIZA_SIMPLE_VIEWS=1`. Its views are registered
with the existing VIEWS broker and window manager, which own navigation, tabs,
windows, and the dormant post-MVP multi-view compositor. Launch builds show one
foreground view at a time. Do not introduce another layout manager here.

## Data contract

Both views consume one server-owned `SimpleViewsSnapshot` per agent. The service
persists that snapshot atomically beneath `ELIZA_STATE_DIR`; browser storage is
never an authoritative data source. UI controls and agent capabilities call the
same validated mutation path so chat-driven and direct interactions cannot
diverge.

## Layout

```
src/
  plugin.ts       Plugin and view declarations
  capabilities.ts Semantic capability declarations shared by both views
  routes.ts       Authenticated `/api/simple-views/*` routes
  service.ts      Runtime service owning the durable store
  store.ts        Atomic JSON persistence and serialized mutations
  interact.ts     View capability dispatcher
  validation.ts   Runtime-boundary parsers
  types.ts        Shared domain types
  views/          Notes and Simple Calendar React surfaces
```

## Commands

```bash
bun run --cwd plugins/plugin-simple-views build
bun run --cwd plugins/plugin-simple-views typecheck
bun run --cwd plugins/plugin-simple-views test
bun run --cwd plugins/plugin-simple-views lint:check
```

## Invariants

- Keep the package developer-only and opt-in; it is a QA workbench, not a
  replacement for the production Calendar or Documents plugins.
- Contribute the renderer through the runtime view manifest only. Do not add a
  second app-shell registration path that can expose the views without the
  backend service.
- Use stable semantic capability and `data-agent-id` identifiers.
- Preserve distinct loading, empty, and error states.
- Mutations return the authoritative resulting snapshot and broadcast
  `simple-views:state-updated` so mounted views converge after agent actions.
- One local agent process owns each `ELIZA_STATE_DIR` while this plugin is
  enabled. Concurrent dev servers use distinct state directories; the store
  does not coordinate writes across operating-system processes.
- Logger only in server code, with `[SimpleViews]` context.
- Fail fast on corrupt persistence; never translate a broken load into empty
  Notes or Calendar state.
