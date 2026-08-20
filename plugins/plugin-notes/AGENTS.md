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
