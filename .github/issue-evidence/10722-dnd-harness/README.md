# #10722 — Real-gesture drag-and-drop harness

Workstream D of the input-interaction gap (#10722): every user-facing
drag-and-drop surface in `packages/app`, inventoried, driven with **real
gestures**, and asserted on **outcomes** (persisted state after reload, bytes
inside the outbound API payload, cancel/no-op paths, rapid-drag invariants).

- Spec: `packages/app/test/ui-smoke/drag-and-drop.spec.ts` (default `chromium`
  project of `playwright.ui-smoke.config.ts` — runs in the normal
  `test:e2e` lane, no config change needed).
- Gesture helpers: `packages/app/test/ui-smoke/helpers/dnd-gestures.ts`.
- Runs: `dnd-run-headless.log` (9/9 green), `dnd-run-recorded.log`
  (E2E_RECORD=1, video), plus the screenshots + video in this directory.

## Gesture fidelity

| Model | How it is driven |
| --- | --- |
| HTML5 `draggable` (plugin rows) | Real mouse input: `mouse.down` → arming jiggle → 8-segment arced `mouse.move` path at ~60Hz pacing → hover pause → `mouse.up`. Chromium's native drag loop runs via Playwright's CDP drag interception, so the product's `dragstart/dragover/drop/dragend` handlers fire exactly as for a human drag. No synthetic `dispatchEvent` shortcut. |
| File drop (chat, knowledge) | Real `DataTransfer` carrying real `File` bytes, dispatched as `dragenter → dragover ×2 → drop`. An OS-level file drag physically cannot originate inside the renderer (the drag source is outside the browser), so this is the strongest possible gesture: everything from the event listener down — intake, FileReader, encode, POST, state — is the real product pipeline. |
| Pointer long-press / tile drag (launcher) | Real mouse press-hold (700 ms, stationary) and a real staged drag path. |

## Surface inventory & verdicts

| # | Surface | Mechanism | Persistence side-effect | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Plugin list custom ordering — `/apps/plugins` (`PluginCard` `<li draggable>` + `PluginsView` handlers) | HTML5 DnD | `localStorage["pluginOrder"]`; `sortPlugins` re-derives order on every mount | **good** — real-mouse drag reorders (exact splice semantics asserted), persists, survives reload; invalid-target release and Escape-cancel are no-ops with clean `onDragEnd` styling cleanup; 3 rapid back-to-back drags keep the permutation invariant and converge localStorage == DOM |
| 2 | Chat overlay file drop — `/chat` (`ContinuousChatOverlay`) | File drop (HTML5) | Pending attachment strip → base64 image inside the `messages/stream` POST | **good after fix** — was a REAL GAP (see finding 1); dropped PNG now renders the pending thumbnail and its exact bytes arrive base64-encoded in the outbound stream body; text-selection drags and aborted hovers are no-ops |
| 3 | Knowledge view file drop — `/character/documents` (`DocumentsView`) | File drop (HTML5) | `POST /api/documents/bulk` (renderer reads + encodes the file) → list refetch | **good after fix** — was a REAL GAP (see finding 2); dropped markdown arrives byte-exact in the bulk payload (`content`, filename, contentType, scope, metadata asserted), ingested doc renders in the list; second immediate drop also ingests (concurrency edge); no-file drop sends no request |
| 4 | Launcher — `/views` (`LauncherSurface` → `Launcher`) | motion/react `Reorder` (pointer) | `localStorage["elizaos.views.launcher"]` (`manual` flag) | **curated by design — reorder disabled in production.** `LauncherSurface` supplies `pageGroups`, which hard-disables edit mode and the `Reorder` wrappers. Contract-tested with real gestures: 700 ms long-press does NOT enter edit mode, a real tile drag does NOT reorder, and no `manual` layout is persisted. The free-form reorder path is only reachable standalone (stories / `packages/ui` `__e2e__` fixtures). |

### Inventoried, not e2e-covered here (lower impact / other lanes)

- **Character editor style-rule / post-example reorder** (`CharacterEditorPanels`, HTML5 row drag) — reachable via the character hub personality section; order commits only on character save. Reproduction: `/character` → Personality → drag a style-rule row. Candidate for a follow-on spec.
- **WorkflowGraphViewer node drag** — React Flow library-managed (`nodesDraggable`); positions are library state, not a product persistence pipeline.
- **KioskViewCanvas floating-window drag** — kiosk mode only (custom pointer drag, transient position).
- **GameViewOverlay window drag** — transient reposition, no persistence.
- **Cloud profile avatar drop** (`cloud/account-security/profile-form`) — cloud UI lane, not part of the packages/app dashboard smoke.
- **Horizontal pager swipes** (launcher pages, chat conversation swipe) — drag-like paging gestures, already covered by `launcher-interaction.spec.ts` / `chat-clear-swipe.spec.ts`.

## Real findings (product bugs/gaps found by the harness)

1. **The live chat surface had NO file-drop support.** The old `ChatView` chat
   surface accepted image drops (`handleImageDrop`), but the shipped
   `ContinuousChatOverlay` that replaced it only supported paste, the attach
   button, and intents — dragging a file onto the chat did nothing.
   **Fixed (contained):** `packages/ui/src/components/shell/ContinuousChatOverlay.tsx`
   wires `onDragOver`/`onDrop` on the interactive `chat-content` layer into the
   SAME `addImageFiles → intakeAttachmentFiles` pipeline paste uses (size caps,
   type support, pending strip all identical). Only file drags are claimed, so
   text-selection drags keep native behavior. No visual chrome added.

2. **The knowledge drop zone is unmounted in the shipped app.** The
   `UploadZone` fieldset ("Drop files here to upload") only renders when
   `DocumentsView` shows its selector rail — but the ONLY live documents
   surface (`CharacterHubView` → `/character/documents`) passes
   `showSelectorRail={false}`, and the companion-overlay editor variant that
   mounts `<DocumentsView inModal />` (with the rail) is itself mounted
   nowhere (`CharacterEditor` is never rendered with `sceneOverlay`). Net:
   drag-drop knowledge upload was unreachable for users.
   **Fixed (contained):** `packages/ui/src/components/pages/DocumentsView.tsx`
   accepts file drops on the view root with the same default options as the
   embedded "Add Knowledge" file input; `documents-upload.tsx` `handleDrop`
   now stops propagation so the rail variant (when mounted) keeps its scoped
   options and never double-uploads.

3. **Escape-cancel semantics note (harness, not product):** native HTML5
   Escape-cancel is a browser-level behavior (dragend fires, no drop). Under
   Playwright's CDP drag interception the keyboard is not routed into the drag
   controller, so the deterministic end-to-end cancel signal is the identical
   product-visible event sequence the browser produces for Escape —
   `dragstart → dragover(s) → dragend` with no `drop` (release away from any
   droppable row). The spec presses Escape for real AND drives that no-drop
   release; product cleanup (`onDragEnd`) is asserted either way.

## Files

- `plugins-01-before-drag.png` / `plugins-02-after-drag.png` /
  `plugins-03-after-reload.png` — reorder + persistence across reload.
- `plugins-04-invalid-drop-noop.png` — invalid-target release, order intact.
- `plugins-05-rapid-drags-converged.png` — after 3 rapid drags.
- `chat-01-dropped-pending-thumbnail.png` — dropped PNG in the pending strip.
- `chat-02-sent-after-drop.png` — post-send (strip cleared, payload asserted).
- `documents-01-before-drop.png` / `documents-02-ingested-in-list.png` /
  `documents-03-second-drop-ingested.png` — knowledge drop ingestion.
- `launcher-01-longpress-no-edit-mode.png` / `launcher-02-drag-noop-curated.png`
  — curated-launcher contract.
- `dnd-run-headless.log` — 9/9 green headless run (verbatim reporter output).
- `dnd-run-recorded.log` + `video-*.webm` — recorded run.

## Repro

```bash
cd packages/app
node scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts \
  test/ui-smoke/drag-and-drop.spec.ts --project=chromium
# recorded:
E2E_RECORD=1 node scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts \
  test/ui-smoke/drag-and-drop.spec.ts --project=chromium
```

Unit-test neighbors of the touched components stay green
(`ContinuousChatOverlay*.test.tsx`, `documents-detail.test.tsx`,
`PluginsView.test.tsx`, `plugin-list-utils.test.ts` — 135 tests).
