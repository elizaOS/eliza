# Simple Views

`@elizaos/plugin-simple-views` provides two lightweight managed Cloud views:

- **Notes** (`notes`) for note creation, editing, deletion, and clearing.
- **Calendar** (`simple-calendar`) for event creation, editing, deletion, date
  selection, and month navigation.

Both surfaces use the standard VIEWS broker. The user can open them directly or
ask the agent to create/show data and switch between Notes and Calendar.
Android and iOS receive statically packaged React renderers; the backend
capabilities and durable state run in the user's managed Cloud agent.

State is stored atomically per agent under
`ELIZA_STATE_DIR/simple-views/agents/<agentId>/state.json`. UI controls and
agent capabilities share one validated mutation path, and mounted views
converge through the normal runtime update event.

## Release path

Merging the code does not deploy it. A release must:

1. deploy/restart the managed agent image so `lean-chat` agents load the
   backend plugin;
2. rebuild the app so the exact merged static renderers are baked into the
   Android/iOS artifact;
3. validate Notes and Calendar create/show/switch flows on that exact artifact.

## Commands

```bash
bun run --cwd plugins/plugin-simple-views build
bun run --cwd plugins/plugin-simple-views typecheck
bun run --cwd plugins/plugin-simple-views test
bun run --cwd plugins/plugin-simple-views lint:check
```
