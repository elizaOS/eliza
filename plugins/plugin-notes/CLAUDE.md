# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents
can create, inspect, update, and delete together.

## Role

This package owns one intentionally focused Cloud surface:

- `notes` — note CRUD with one user-authored content field and optional color.

The persisted schema retains a derived first-line label plus body for stable
lookup and compatibility with existing notes. That split is deterministic:
planner capabilities prefer one `content` value, while the chat action also
losslessly normalizes providers that preserve an explicitly requested title and
body as separate arguments. The view renders the combined content as one field.

Managed dedicated agents load the runtime plugin through the `lean-chat`
profile. The app build loads `src/register.ts` through the manifest-driven app
registration scanner, which statically packages the React renderer for Android
and iOS. Native clients therefore never fetch plugin JavaScript.

The shared VIEWS broker and shell own navigation, tabs, windows, and
interaction transport. Do not introduce another layout or navigation system
here. Calendar belongs to `@elizaos/plugin-calendar` — do not add calendar
views or event state to this package.

## Layout

- `src/types.ts` — shared domain contracts (one schema, no parallel models).
- `src/validation.ts` — the only validation layer; every untrusted boundary
  (persisted JSON, HTTP bodies, capability params) goes through it.
- `src/store.ts` — atomic per-agent JSON persistence with a shared in-process
  write barrier.
- `src/service.ts` — `NotesService`, the only layer allowed to mutate state.
- `src/action.ts` — owner-only chat CRUD over the same service.
- `src/provider.ts` — owner-only saved-note context for chat recall.
- `src/interact.ts` — server capability broker (`serverInteract`).
- `src/capabilities.ts` — planner-visible capability declarations.
- `src/routes.ts` — authenticated `GET /api/notes/state`.
- `src/register.ts` — static app-shell page registration.
- `src/views/` — React renderer, browser transport, and sync hook.

## Invariants

- The server owns all state; the view renders the authoritative snapshot.
- Loading, designed-empty, and error are three distinguishable renders.
- Failures throw typed `ElizaError`s; nothing fabricates a healthy empty state.
- All chat action and provider exposure is OWNER-gated because storage is
  per-agent rather than per-sender.
- `clear-notes` validates `expectedRevision` inside the store write barrier, so
  a note committed between confirmation and commit aborts the clear instead of
  being wiped. The dispatch-time snapshot check is only a fast path.

Saved-note prompt rows are JSON pairs `[exact ID, complete content]`. Keep canonical label/newline/body boundaries inside the content string and bind the ID in the same row; never split IDs into a separate positional list or flatten content into a display dash that can corrupt a partial update.

Direct-text planner/completion context can use the provider-owned exact title/count index. Complete note bodies remain in the authorized provider result and are retrieved through the shared context-restoration protocol or NOTES before body recall or replacement. Never turn labels into inferred body text; keep full JSON-string line boundaries on retrieval.

Literal chat updates may supply textEdit with a field, exact oldText and newText.
Validate this alternative at the existing boundary and match under the store
write barrier. Require a unique current match and preserve every other character;
reject ambiguous, absent, conflicting or normalization-dependent edits without a
write. Full replacement and legacy selector/content forms remain supported, but replacement writes now require a read-bound expectedRevision. This is
structured tool input, never a natural-language shortcut or a second write path.

Conversational NOTES_PATCH uses a typed target and field changes or one literal textEdit. Omitted fields stay unchanged. Ambiguous named titles require selection even if a planner substitutes an ID; resolve again under the service write barrier. Keep legacy NOTES_UPDATE content alternatives and their conflict validation.

NOTES_LIST may combine title/topic lookup with an explicit createdAt/updatedAt dateRange. Bounds are offset-bearing instants, start-inclusive/end-exclusive. Date filters never authorize a write or change source ownership.

NAMED_NOTES supplies complete current records only for titles explicitly named in the request, including every same-title match. Planning and explicit context reads admit it with the existing OWNER gate. Unrelated messages receive no named-note text; source failures do not authorize claims from historical contents.


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
