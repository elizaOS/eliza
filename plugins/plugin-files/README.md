# @elizaos/plugin-files

Managed browser files with transactional revisions, selected-file capabilities,
exact-byte import/export, and atomic workflow receipts. Native filesystem access
continues to belong to plugin-native-filesystem.

Hosts call `createBrowserFiles` with their persistent database name, PDF worker
and asset URLs, cancellable picker, and sandboxed document viewer. Configure once
per storage domain and register the returned class through the host's shared
Capacitor registry. Do not rename an existing database without a data migration.
The factory does not register plugins, choose account authority, or mount UI.

The `documents/*` exports provide scan correction and edge suggestions, reviewed
text-layer validation, PDF generation, local OCR and revisioned draft persistence.
The host supplies PDF metadata, an OCR worker/assets URL and language, and the
draft database name. OCR uses the Tesseract 7 worker protocol; host the worker,
WASM and language data together. The caller owns scan cancellation; no elapsed-time
deadline or remote OCR service is selected implicitly.

Run `bun run typecheck`, `bun run test`, `bun run lint:check`, and `bun run build`
in this package. Consumer qualification
must exercise IndexedDB transactions, stale selections, cancellation, restart
receipts and exact-byte file flows in a real browser.
