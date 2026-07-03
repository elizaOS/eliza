# #10722 — Native HTML5 drag-and-drop coverage

Native HTML5 drag-and-drop had **zero** automated coverage. This adds real
jsdom tests that dispatch actual `dragstart` / `dragover` / `drop` DOM events
carrying a populated `DataTransfer` and assert **semantic** outcomes (upload
handler invoked with the right file / decoded content; card order actually
changed and persisted) — not "no error".

## Code under test (unchanged — test-only PR)

- `packages/ui/src/components/pages/documents-upload.tsx` → `UploadZone.handleDrop`
  (native file-drop upload).
- `packages/ui/src/components/pages/DocumentsView.tsx` → `handleRootDrop` +
  `handleFilesUpload` (the real validation / batching / bulk-upload path).
- `packages/ui/src/components/pages/PluginsView.tsx` → `handleDragStart` /
  `handleDragOver` / `handleDrop` reorder + localStorage persistence, rendering
  `PluginCard` draggable rows.

## New tests

- `packages/ui/src/components/pages/documents-upload.dnd.test.tsx` (11 tests)
  - **File drop → upload:** a real `drop` with `dataTransfer.files` invokes
    `onFilesUpload` with the dropped `File` and the zone's live scope options.
  - **Real upload path:** dropping a `.txt` on the DocumentsView root drives
    `handleFilesUpload` → `client.uploadDocumentsBulk` is called with the file's
    FileReader-decoded content (`"hello world"`), filename, and scope.
  - **Edge cases:** multiple files batched into one request; wrong type
    (`.exe`) rejected with the "No supported non-empty files" notice and **no**
    network call; supported-but-empty (0-byte) file rejected; empty drop (no
    files) is a no-op; drop while `uploading` ignored.
  - **No double-upload:** a drop inside the zone calls `stopPropagation`, so an
    outer drop target never fires (#10722 regression guard).
- `packages/ui/src/components/pages/PluginsView.reorder.test.tsx` (5 tests)
  - Cards render in the expected order at rest; dragging a card ahead of / behind
    a sibling **actually changes the rendered order** and **persists** it to
    `localStorage["pluginOrder"]`.
  - The persisted list has **no duplicate and no `undefined`/`null` ids** (splice
    correctness), verified across two successive reorders.
  - A drop onto the same card (no movement) is a **no-op**: order unchanged and
    nothing persisted.

## Result

```
Test Files  2 passed (2)
     Tests  16 passed (16)
```

(full per-test list in `test-output.txt`)

## Mutation check (proof the tests are not vacuous)

Temporarily breaking the reorder splice in `PluginsView.tsx`
(`ids.splice(fromIdx, 1); ids.splice(toIdx, 0, srcId)` → skipped) made **3 of the
5** reorder tests fail — the reorder/persistence assertions — while the
"at-rest order" and "no-op self-drop" tests correctly stayed green. Source was
restored; final tree is test-only.

```
❯ PluginsView.reorder.test.tsx (5 tests | 3 failed)
  × reorders cards and persists the new order when a card is dropped ahead of another
  × moves a card backward when dropped onto a later sibling
  × survives a second reorder without duplicating or dropping any id
```

## Verification commands

```
bun run --cwd packages/ui test  (scoped to the two files) → 16/16 pass
bun run --cwd packages/ui typecheck                       → clean
bunx @biomejs/biome check <files>                         → clean
```

N/A rows: no product source changed (test-only), so no UI screenshots / video /
real-LLM trajectories / device capture apply.
