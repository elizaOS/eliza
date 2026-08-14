# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents
can create, inspect, update, and delete together.

## Role

This package owns one intentionally focused Cloud surface:

- `notes` — note CRUD with one user-authored content field and optional color.

The persisted schema retains a derived first-line label plus body for stable
lookup and compatibility with existing notes. That split is deterministic:
planner capabilities accept one `content` value and never ask a model to invent
a separate title or summary. The view renders the combined content as one field.

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
- `src/interact.ts` — server capability broker (`serverInteract`).
- `src/action.ts` — `NOTES`, the chat-side door onto the same service.
- `src/provider.ts` — `SAVED_NOTES`, the read seam that renders the canonical
  snapshot into turn context so a saved note is recallable.
- `src/capabilities.ts` — planner-visible capability declarations.
- `src/routes.ts` — authenticated `GET /api/notes/state`.
- `src/register.ts` — static app-shell page registration.
- `src/views/` — React renderer, browser transport, and sync hook.

## Invariants

- The server owns all state; the view renders the authoritative snapshot.
- Loading, designed-empty, and error are three distinguishable renders.
- Failures throw typed `ElizaError`s; nothing fabricates a healthy empty state.
- `NotesService` is the only store. Notes reach recall by being rendered from
  that snapshot at read time — never by mirroring note text into a memory
  record, which would be a second copy that survives an edit or a delete.
