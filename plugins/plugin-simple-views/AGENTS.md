# @elizaos/plugin-simple-views

Managed Cloud Notes and Calendar views for lightweight personal data that users
and agents can create, inspect, update, and delete together.

## Role

This package owns two intentionally focused Cloud surfaces:

- `notes` — sticky-note CRUD with title, body, and color.
- `simple-calendar` — event CRUD, month navigation, and selected date.

Managed dedicated agents load the runtime plugin through the `lean-chat`
profile. The app build loads `src/register.ts` through the manifest-driven
app registration scanner, which statically packages both React renderers for
Android and iOS. Native clients therefore never fetch plugin JavaScript.

The shared VIEWS broker and shell own navigation, tabs, windows, and interaction
transport. Do not introduce another layout or navigation system here.

## Data contract

Both views consume one server-owned `SimpleViewsSnapshot` per agent. The
service persists that snapshot atomically beneath `ELIZA_STATE_DIR`; browser
storage is never authoritative. UI controls and agent capabilities call the
same validated mutation path so chat-driven and direct interactions cannot
diverge.

## Layout

```
src/
  plugin.ts       Runtime plugin and Cloud view declarations
  register.ts     Static app-shell renderer registrations
  capabilities.ts Semantic capability declarations shared by both views
  routes.ts       Authenticated Cloud state route
  service.ts      Runtime service owning the durable store
  store.ts        Atomic JSON persistence and serialized mutations
  interact.ts     View capability dispatcher
  validation.ts   Runtime-boundary parsers
  types.ts        Shared domain types
  views/          Notes and Calendar React surfaces
```

## Commands

```bash
bun run --cwd plugins/plugin-simple-views build
bun run --cwd plugins/plugin-simple-views typecheck
bun run --cwd plugins/plugin-simple-views test
bun run --cwd plugins/plugin-simple-views lint:check
```

## Invariants

- Runtime capabilities load by default only for managed `lean-chat` Cloud
  agents; local and remote profiles do not acquire this plugin implicitly.
- Keep the native renderers statically registered. Android and iOS reject
  dynamic plugin bundles by design.
- Launcher entries are visible only while Eliza Cloud is connected.
- Use stable semantic capability and `data-agent-id` identifiers.
- Preserve distinct loading, empty, and error states.
- Mutations return the authoritative resulting snapshot and broadcast
  `simple-views:state-updated` so mounted views converge after agent actions.
- Logger only in server code, with `[SimpleViews]` context.
- Fail fast on corrupt persistence; never translate a broken load into empty
  Notes or Calendar state.
