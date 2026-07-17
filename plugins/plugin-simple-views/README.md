# Simple Views

`@elizaos/plugin-simple-views` is an opt-in developer workbench for testing
agent-driven application control. It contributes two intentionally small views:

- **Notes** (`notes`) for note creation, editing, deletion, and clearing.
- **Simple Calendar** (`simple-calendar`) for event creation, editing, deletion,
  date selection, and month navigation.

The views use the standard VIEWS broker and existing window manager, so the
same surfaces can be opened, closed, split, tiled, pinned, and repositioned by
chat or by direct UI interaction. This package does not replace the production
Calendar, Documents, or Personal Assistant plugins.

## Run locally

Enable the plugin when starting the normal app development server:

```bash
ELIZA_SIMPLE_VIEWS=1 bun run dev
```

Open `http://localhost:2138/notes` or
`http://localhost:2138/simple-calendar`. A useful chat-driven smoke test is:

1. Open the Notes view.
2. Create a note titled “Launch checklist”.
3. Open the Simple Calendar view.
4. Create an event for tomorrow.
5. Split Notes and Simple Calendar side by side.

State is stored atomically under `ELIZA_STATE_DIR/simple-views/state.json`.
Both direct controls and agent capabilities use the same validation and
mutation path, and mounted views converge through the normal runtime update
event.

## Commands

```bash
bun run --cwd plugins/plugin-simple-views build
bun run --cwd plugins/plugin-simple-views typecheck
bun run --cwd plugins/plugin-simple-views test
bun run --cwd plugins/plugin-simple-views lint:check
```
