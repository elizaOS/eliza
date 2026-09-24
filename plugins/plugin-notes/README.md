# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents can
create, inspect, update, and delete together.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-notes build  # build
bun run --cwd plugins/plugin-notes test   # tests
```

## Editing notes

`NOTES_PATCH` requires `expectedRevision` from the complete note snapshot used to prepare the edit. Any intervening Notes mutation requires a fresh read and reconciliation. For an atomic literal substitution without a revision, use `NOTES_UPDATE` with `textEdit`; it must match exactly once and preserves all other text.
