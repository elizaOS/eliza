# @elizaos/plugin-pdf

PDF reading and text extraction service for Eliza agents.

## Purpose / Role

Adds `PdfService` (`ServiceType.PDF`) to an Eliza agent runtime, enabling PDF buffers to be parsed and their text extracted. The plugin registers no actions, providers, or evaluators — it exposes only a service that other plugins, actions, or agent code can call via `runtime.getService(ServiceType.PDF)`. It is opt-in: list `"@elizaos/plugin-pdf"` in the character's `plugins` array to enable it. Builds target both Node.js and browser environments via separate entry points.

## Plugin Surface

| Kind | Name | Description |
|------|------|-------------|
| Service | `PdfService` (`ServiceType.PDF`) | Parses PDF buffers; extracts plain text, per-page info, and document metadata using `unpdf`. |

No actions, providers, evaluators, routes, or events are registered.

## Layout

```
plugins/plugin-pdf/
  index.ts              Plugin definition (exports pdfPlugin, PdfService, types)
  index.node.ts         Node.js entry point re-export
  index.browser.ts      Browser entry point re-export
  services/
    index.ts            Re-exports PdfService
    pdf.ts              PdfService implementation — all extraction logic lives here
  types/
    index.ts            PdfConversionResult, PdfExtractionOptions, PdfPageInfo,
                        PdfMetadata, PdfDocumentInfo interfaces
  __tests__/
    core-test-mock.ts   Vitest mock for @elizaos/core (Service, ServiceType, logger)
  prompts/
    evaluators.json     (reserved; not loaded by current plugin surface)
  build.ts              Bun.build script (node + browser dual output)
```

## Commands

All scripts are from `package.json`. Run from repo root with `--cwd`:

```bash
bun run --cwd plugins/plugin-pdf build          # production build (node + browser)
bun run --cwd plugins/plugin-pdf dev            # watch mode build
bun run --cwd plugins/plugin-pdf test           # vitest run
bun run --cwd plugins/plugin-pdf typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-pdf lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-pdf lint:check     # biome check (read-only)
bun run --cwd plugins/plugin-pdf format         # biome format --write
bun run --cwd plugins/plugin-pdf clean          # rm -rf dist .turbo
```

## Config / Env Vars

None. The plugin reads no environment variables and requires no configuration. `unpdf` is self-contained (no external PDF service).

## How to Extend

### Add a new action that uses PdfService

1. Create `actions/<name>.ts` implementing `Action` from `@elizaos/core`.
2. Inside the action handler, call `runtime.getService<PdfService>(ServiceType.PDF)` to get the service instance.
3. Export the action from `actions/index.ts` (create if absent).
4. Add it to the `actions` array in the `pdfPlugin` object in `index.ts`.

### Add a new method to PdfService

Edit `services/pdf.ts`. The class extends `Service` from `@elizaos/core`. Add the method, update `types/index.ts` with any new interfaces, and export them from `types/index.ts` (they are re-exported from `index.ts` via `export * from "./types"`).

### Add a provider

1. Create `providers/<name>.ts` implementing `Provider` from `@elizaos/core`.
2. Export from `providers/index.ts`.
3. Add to the `providers` array in `pdfPlugin` in `index.ts`.

## Conventions / Gotchas

- **Dual build (node + browser).** `build.ts` produces `dist/node/index.node.js` and `dist/browser/index.browser.js`. The `exports` field in `package.json` routes consumers automatically. Keep both entry points in sync when adding exports.
- **`unpdf` dependency.** Replaces the older `pdfjs-dist` reference in README; actual runtime dep is `unpdf ^1.4.0` (`getDocumentProxy`). Do not import `pdfjs-dist` directly.
- **Buffer input.** All public methods accept `Buffer` (Node.js) and convert internally to `Uint8Array` for `unpdf`. Browser callers must supply a compatible buffer.
- **`cleanUpContent` strips control characters** (C0 except `\t`, `\r`, `\n`; also strips DEL/0x7F). Call it on any raw text before surfacing to the agent.
- **No actions registered.** The plugin surface is service-only. To expose PDF capabilities to the LLM turn loop, an action must be added explicitly (see "How to Extend").
- **`ServiceType.PDF`** is the lookup key. Use `runtime.getService<PdfService>(ServiceType.PDF)` — not a string literal.
- **Logging uses `logger` from `@elizaos/core`**, prefixed `PdfService:` per repo convention.
