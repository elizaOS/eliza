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

`NOTES_PATCH` edits individual fields with required `target: { kind: "id" | "text", value }` and `changes: [{ field: "title" | "body", value }]`. Supply at least one change, or use `changes: []` with `textEdit` for an exact substring substitution. Never combine both forms; omitted fields remain unchanged. It uses the same owner-only Notes service and rejects ambiguous targets, conflicting edits, and normalization-dependent text.

The legacy `NOTES_UPDATE` chat action identifies the existing note with an exact `noteId` or
`content` text, never both, and takes
its complete new text in `replacementContent` (label, newline, then body).
The promoted update tool requires `content` on the model wire. Runtime admission
also accepts the explicitly declared legacy selectors `text`, `note`, `title`,
and `query` when `content` is absent. Each must be a valid nonempty string;
conflicting selectors fail without writes. This compatibility does not make
`content` required for unfiltered lists or replace the exact `noteId` GET contract.
For literal substitutions, supply `textEdit: { field: "title" | "body", oldText,
newText }` instead of `replacementContent`. The service requires one unique
case-sensitive literal match in the current field and commits under the existing
write barrier; every other character and field is preserved. Missing or repeated
matches, mixed update forms, and edits requiring storage normalization fail
without writing. No full-note read or model rewrite is needed when the user
already supplied the exact target and replacement.

`body` is shown only for create calls; legacy update callers using `body` or
`newText` remain supported. Partial edits must preserve the unchanged label
and lines in the replacement; the server does not infer or invent them.

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

Read a specific saved ID with `NOTES_GET { noteId }`; IDs match exactly and
case-sensitively. Use `content` for title/body search, or neither field to list
all notes. Mixed ID and text filters fail explicitly. Read results record
`lookupMode` (`exact_id`, `text`, or `all`) so an empty text search is not
mistaken for proof that an ID is absent. Reads do not mutate notes.
The `NOTES_GET_NOTE` retrieval hint resolves to `NOTES_GET`. This promoted
operation requires noteId and has no text-search field. Both reads use the
existing Notes service; `NOTES_LIST { noteId }` also retains exact-ID support.

The fresh saved-note discovery index pairs every exact ID with its complete
title in a JSON row `[ID, title]`, with the row format declared once. It
supports exact-ID existence and count checks without exposing note bodies.
Full context pairs each exact ID with unchanged complete content in one JSON row;
body retrieval still requires the full reference or an exact read.


Individual field and full-note replacements require `expectedRevision` from the
complete note snapshot used to prepare the edit. `NOTES_GET` / `NOTES_LIST` and
full `SAVED_NOTES` / `NAMED_NOTES` content expose `notesRevision`; capability reads
expose `state.revision`. Pass that value to `NOTES_UPDATE`, nonempty `NOTES_PATCH`
changes, or `update-note`. Direct service updates take it as their final argument.
A title-only index is not replacement content. Never fetch a fresh token alone to
retry stale replacement bytes: read the note and reconcile the owner's edit.

The service compares the whole-document revision inside its write barrier.
Any intervening Notes mutation, including another note's change, causes
`NOTES_EDIT_CONFLICT` without a write or applied receipt. Missing or invalid
replacement tokens return `NOTES_EDIT_REVISION_REQUIRED`; this deliberately
rejects older unguarded replacement calls. Literal `textEdit` retains its atomic
unique-current-substring contract and can omit the token; supplied tokens still
apply. Storage remains the existing per-agent JSON file and in-process barrier.

Promoted `NOTES_PATCH` now requires `expectedRevision` on its native schema for every call, including legacy `textEdit` calls through that tool. Use the existing `NOTES_UPDATE` with `textEdit` for revision-free atomic literal substitutions. Full field replacements use PATCH with the revision of the complete snapshot used to author the change. This schema requirement prevents repeated revisionless replacement calls; it does not fetch or invent a token, relax the write barrier, or remove the existing service/umbrella literal-edit contract. Any intervening Notes write, including a deletion in the same request, requires a fresh complete snapshot before replacement.
