# Notes

`@elizaos/plugin-notes` provides the lightweight managed Cloud **Notes** view
(`notes`): sticky-note creation, editing, deletion, and clearing.

The surface uses the standard VIEWS broker. The user can open it directly or
ask the agent to create/show notes. Android and iOS receive a statically
packaged React renderer; the backend capabilities and durable state run in the
user's managed Cloud agent.

State is stored atomically per agent under
`ELIZA_STATE_DIR/notes/agents/<agentId>/state.json`. UI controls and agent
capabilities share one validated mutation path, and mounted views converge
through the normal runtime update event.

Calendar UI lives in `@elizaos/plugin-calendar`, which renders real Google,
Microsoft, Apple, and ICS calendar data from its own services.

## Release path

- Runtime plugin: `src/plugin.ts` (service, routes, view manifest,
  capabilities, server interaction broker).
- App registration: `src/register.ts` statically registers the Notes page in
  the signed app bundle.
- Dynamic view bundle: `bun run build:views` emits `dist/views/bundle.js` for
  web hosts that load plugin views dynamically.

## Testing

```bash
bun run --cwd plugins/plugin-notes typecheck
bun run --cwd plugins/plugin-notes test
```

## Filesystem publication

Existing flat `state.json` documents remain authoritative. On filesystems that
deny hard links, including Android app storage, first initialization publishes
a complete `state.json.store/state.json` using an atomic nonempty-directory
rename. Competing initializers read the winner. Subsequent writes atomically
replace the inner document; restart resolves the same format. An existing
publication with missing or malformed content fails explicitly. Interrupted
unpublished candidates are never read as state. Backups must retain the
`state.json.store` directory when that format is present.
