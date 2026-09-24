# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents can
create, inspect, update, and delete together.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-notes build  # build
bun run --cwd plugins/plugin-notes test   # tests
```

Promoted `NOTES_PATCH` requires the revision of the complete note snapshot used for replacement. Atomic literal substitutions use existing `NOTES_UPDATE` with `textEdit`. Preserve the owner, ambiguity and stale-write guards; do not invent or refresh a revision alone.
