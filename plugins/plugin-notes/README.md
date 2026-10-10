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

Service create/update inputs using `title`/`body` treat a nonempty body as lines after the title: one separator is added, including when the supplied body already starts with a newline. An empty body clears it; omitted fields remain unchanged. Use `{ content }` for a complete verbatim note and `textEdit` for a literal edit of stored fields. Do not mix complete content with structured fields. Stored schema-2 `body` includes its separator and is not a structured input body.

The app renderer resolves the package to `src/browser.ts`, which keeps views and
client registration separate from runtime actions and provider storage.

The separate `./client` entry provides device-local note contracts, persistence
and encrypted compare-and-exchange migration. Hosts supply storage keys, the
native vault and legacy storage; preserve installed namespaces when adopting it.
These device clients do not replace Cloud tenant storage or grant account authority.

`DocumentNotesStore` reuses the same device-local envelope over a host-supplied
atomic asynchronous document port. Hosts own initial legacy capture, opaque
revision receipts, backup/reset and storage protection; the client never writes a
synchronous mirror or claims that browser storage is encrypted. A stale writer
fails instead of merging or replacing another view's saved Notes.

The encrypted adapter delegates commits to this same document engine. Its opaque
revision binds the complete encrypted envelope, including migration archives.
Authorization and cancellation are rechecked after edit preparation and before CAS.

The device client also provides Trash retention, maintenance and foreground scheduling.
Hosts supply retention and size limits, note kinds, durable storage, a shared mutation
lock and recording cleanup. Maintenance checks saved live notes again under that lock.
It retains expired entries when owned content cannot be erased and removes stale
Trash rows without erasing a restored note. These helpers do not change Cloud deletion
or start a background service.
