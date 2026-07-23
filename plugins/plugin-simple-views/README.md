# Simple Views

`@elizaos/plugin-simple-views` is an opt-in developer workbench for testing
agent-driven application control. It contributes two intentionally small views:

- **Notes** (`notes`) for note creation, editing, deletion, and clearing.
- **Simple Calendar** (`simple-calendar`) for event creation, editing, deletion,
  date selection, and month navigation.

The views use the standard VIEWS broker and existing window manager, so either
surface can be opened, closed, or pinned by chat and direct UI interaction.
Launch builds show one foreground view at a time; the shared
multi-view compositor remains dormant for post-MVP work. This package does not
replace the production Calendar, Documents, or Personal Assistant plugins.

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
5. Switch back to Notes and verify the saved note is still present.

State is stored atomically per agent under
`ELIZA_STATE_DIR/simple-views/agents/<agentId>/state.json`. On first use, a
validated legacy `ELIZA_STATE_DIR/simple-views/state.json` is copied without
deleting the original or replacing existing scoped state. Both direct controls
and agent capabilities use the same validation and mutation path, and mounted
views converge through the normal runtime update event.

One local agent process must own a given `ELIZA_STATE_DIR` while this workbench
is enabled. Run concurrent development servers with distinct state directories;
duplicate service instances inside one process share a write barrier, but
separate operating-system processes do not coordinate mutations.

## Commands

```bash
bun run --cwd plugins/plugin-simple-views build
bun run --cwd plugins/plugin-simple-views typecheck
bun run --cwd plugins/plugin-simple-views test
bun run --cwd plugins/plugin-simple-views lint:check
```
