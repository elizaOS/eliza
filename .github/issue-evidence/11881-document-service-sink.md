# Issue #11881: DocumentService sink adapter support slice

## Scope

Track F support work for the conversation importer:

- Added a reusable `createDocumentServiceSink` adapter that maps the importer `DocumentSink` contract to a real `DocumentService`-shaped `addDocument` / `deleteDocument` API.
- Exported it from the package root and from `@elizaos/import-conversations/adapters/document-service`.
- Added focused tests for field mapping, deterministic client document ids, context defaults, delete delegation, custom skip-status mapping, and invalid service results.

This does not implement Track E's upload/preview/manage UI.

## Verification

```sh
bun run --cwd packages/import-conversations lint:fix
bun run --cwd packages/import-conversations test src/adapters/document-service.test.ts
bun run --cwd packages/import-conversations test
bun run --cwd packages/import-conversations typecheck
bun run --cwd packages/import-conversations build
git diff --check
```

Results:

- Adapter test: 1 file passed, 6 tests passed.
- Full importer package test suite: 10 files passed, 106 tests passed.
- Typecheck: passed.
- Build: passed.
- Whitespace check: passed.

## Notes

The current `DocumentService.addDocument` return value does not expose whether an existing content-based document was skipped. The adapter therefore defaults to `status: "stored"` and accepts `statusFromResult` for callers that can supply a reliable skip signal.
