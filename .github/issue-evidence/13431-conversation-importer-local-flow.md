# #13431 Conversation Importer Local Flow Evidence

## Current Implementation

- Added the canonical conversation import entry point to `packages/ui/src/components/pages/MemoryViewerView.tsx` as a third Memories view mode: Feed / Browse / Import.
- The UI supports ChatGPT, Claude, Hermes, and OpenClaw source selection through the browser-safe `@elizaos/import-conversations/browser` subpath.
- Browser parsing and preview now reuse the canonical import pipeline instead of a UI-local parser: `previewConversationImportText()` dry-runs canonical document rendering and `runConversationImportText()` writes through the canonical document sink.
- The Import panel shows scrubbed preview counts/examples, keeps secret scrubbing enabled by default, gates import behind explicit consent, reports local progress/completion/readback state, and exposes batch delete through the manifest uninstall path.
- Raw source retention is opt-in for the current browser session only. By default, the selected raw export text is cleared after import.
- Imported conversations are stored as documents through `uploadDocument()` with `scope: "user-private"`, `addedFrom: "import"`, `metadata.source: "import"`, and canonical `metadata.import` provenance (`source`, `sourceConversationId`, `importBatchId`, date range, part info).
- `/api/documents` now preserves the `addedFrom: "import"` contract for this local import flow instead of stamping importer writes as ordinary manual uploads.
- Document presentation types now include an `import` provenance kind labelled "Conversation import".

## Coverage Added

- `packages/import-conversations/src/browser.test.ts`
  - Browser-safe ChatGPT/Claude/OpenClaw/Hermes parsing and dry-run/write behavior through the canonical pipeline.
- `packages/ui/src/components/pages/conversation-import-documents.test.ts`
  - Adapter mapping from canonical `SinkDocument` to the document upload API, including `scope`, `scopedToEntityId`, `addedFrom`, and import metadata preservation.
- `packages/ui/src/components/pages/MemoryViewerView.conversation-import.test.tsx`
  - Component-level Import panel coverage for source selection, scrubbed preview, consent gate, import write/readback completion, and batch delete.
  - Asserts the uploaded document content does not contain the source secret and the upload payload carries import provenance.

## Verification Run

- `node packages/shared/scripts/generate-keywords.mjs --target ts` to restore generated i18n keyword data required by the local sparse worktree.
- `bun run --cwd packages/import-conversations test src/browser.test.ts` - passed, 4 tests.
- `bun run --cwd packages/ui test src/components/pages/conversation-import-documents.test.ts src/components/pages/MemoryViewerView.conversation-import.test.tsx` - passed, 2 files / 2 tests.
- `bunx @biomejs/biome check packages/ui/src/components/pages/MemoryViewerView.tsx packages/ui/src/components/pages/MemoryViewerView.conversation-import.test.tsx packages/ui/src/components/pages/conversation-import-documents.ts packages/ui/src/components/pages/conversation-import-documents.test.ts packages/ui/src/api/client-chat.ts packages/ui/src/api/client-types-chat.ts plugins/plugin-documents/src/routes.ts plugins/plugin-documents/src/document-presenter.ts packages/core/src/features/documents/types.ts packages/core/src/features/documents/service.ts` - passed.

## Scope Notes

- Re-import idempotency/duplicate detection is provided by the canonical `runImport()` manifest classification and sink `skipped` result handling. The UI keeps the latest local manifest for batch delete and status display, but it does not persist resumable jobs across page reloads in this slice.
- Full cloud resumable upload/quota work remains outside this local-flow PR and is tracked separately.
- App visual audit screenshots/video were not captured in this takeover worktree. The functional component test now covers the Import panel interactions that were previously missing.
