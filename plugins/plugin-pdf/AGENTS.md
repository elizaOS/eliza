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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — storage / memory:**
- The actual rows / embeddings / documents written **and read back**, with their shape inspected — not a mock asserting itself.
- Query correctness: precision/recall on real data, ordering, pagination, and migration up/down.
- GC/retention, concurrency, and large-payload paths.
- A trajectory showing memory/knowledge actually recalled into a turn, where relevant.
<!-- END: evidence-and-e2e-mandate -->
