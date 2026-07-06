# @elizaos/plugin-documents

HTTP API surface for the elizaOS document store.

## Purpose / role

Registers a set of REST routes that expose document CRUD, bulk upload, URL ingestion, semantic search, and fragment listing against the runtime's document store. The plugin delegates all persistence and search to `DocumentsServiceLike` (resolved from `@elizaos/agent/api/documents-service-loader`). It does not register owner actions; `OWNER_DOCUMENTS` is host-adapted by `@elizaos/plugin-personal-assistant`, which owns approval queue gating, scheduled-task deadline tracking, and document-request orchestration. This plugin has no providers, evaluators, or event handlers.

Loading: added explicitly to the agent plugin list or via character config. It is not unconditionally enabled by default; the runtime must resolve it by name (`@elizaos/plugin-documents`).

Repo-wide conventions (logger-only, ESM, naming, architecture rules, git workflow) live in the root [AGENTS.md](../../AGENTS.md) — not repeated here.

## Plugin surface

**Routes** (all registered under the agent HTTP server via `rawPath: true`):

| Method | Path | What it does |
|--------|------|--------------|
| GET    | `/api/documents` | List documents with filtering, pagination, access control |
| GET    | `/api/documents/stats` | Document and fragment counts for the agent |
| GET    | `/api/documents/search` | Semantic/keyword/hybrid search across documents |
| GET    | `/api/documents/:id` | Fetch a single document (includes content) |
| GET    | `/api/documents/:id/fragments` | List all text fragments for a document |
| POST   | `/api/documents` | Upload a single document (text, image, binary) |
| POST   | `/api/documents/bulk` | Bulk upload up to 100 documents |
| POST   | `/api/documents/url` | Fetch and ingest a URL or YouTube transcript |
| PATCH  | `/api/documents/:id` | Update document text content (re-fragments) |
| DELETE | `/api/documents/:id` | Delete document and all its fragments |

**Actions:** none registered here. `OWNER_DOCUMENTS` is registered by
`@elizaos/plugin-personal-assistant` and delegates to this package's document
routes/store where appropriate.

No providers, services, evaluators, or event handlers are registered.

## Layout

```
src/
  index.ts               Barrel — re-exports plugin.ts, routes.ts, service-loader.ts
  plugin.ts              Builds Route[] + exports documentsPlugin (Plugin object)
  routes.ts              handleDocumentsRoutes() — all route logic; documentRouteHandler() adapter
  document-presenter.ts  presentDocument(), getDocumentEditability(), getDocumentDeleteability(),
                         getDocumentProvenance(), getDocumentVisibilityScope(), etc.
  service-loader.ts      Re-exports canonical types and getDocumentsService() from
                         @elizaos/agent/api/documents-service-loader
  components/
    documents/
      DocumentsView.tsx          React view for documents UI
      documents-view-bundle.ts   View bundle entry
      DocumentsView.test.tsx     Component tests
test/
  documents-api.live.e2e.test.ts   Live API e2e tests
  documents-live.e2e.test.ts       Live document ingestion e2e tests
  routes.test.ts                   Unit tests for route logic
```

## Commands

Scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-documents build               # build:js + build:views + build:types
bun run --cwd plugins/plugin-documents build:js            # tsup bundling
bun run --cwd plugins/plugin-documents build:views         # vite build for view bundles
bun run --cwd plugins/plugin-documents build:types         # tsc --noCheck type emit
bun run --cwd plugins/plugin-documents clean               # rm -rf dist
bun run --cwd plugins/plugin-documents test                # vitest run (unit tests)
bun run --cwd plugins/plugin-documents test:e2e:manual     # vitest run live e2e tests
```

No `lint` or `typecheck` scripts — use repo-root commands for those.

## Config / env vars

The plugin itself reads no env vars directly. The `routes.ts` handler reads one runtime setting:

| Setting key | Source | Purpose |
|-------------|--------|---------|
| `ELIZA_ADMIN_ENTITY_ID` | `runtime.getSetting(...)` | Identifies the OWNER actor for document access-control decisions |

Access control is role-based, resolved from request headers:
- `x-eliza-entity-id` / `x-eliza-actor-entity-id` — caller's entity UUID
- Role inferred as `OWNER`, `USER`, or `AGENT` based on header vs known agent/owner IDs

## How to extend

**Add a new route:**
1. Add the method + path to `DOCUMENT_ROUTES` in `src/plugin.ts`.
2. Implement the handler branch inside `handleDocumentsRoutes()` in `src/routes.ts`. Follow the existing pattern: resolve actor, check access with `canReadDocumentMemory`/`canMutateDocumentMemory`, delegate to `documentsService`, call `json(res, ...)` or `error(res, ...)`.
3. Every route must have a real caller (UI or agent action) per root AGENTS.md rule 10.

**Add a new presenter field:**
Add to `PresentedDocument` in `src/document-presenter.ts` and populate it in `presentDocument()`.

**Add document scope enforcement logic:**
All scope/permission decisions live in `src/routes.ts` (`canReadDocumentMemory`, `canMutateDocumentMemory`, `filtersFromUploadBody`). Do not scatter access checks into the presenter or service.

## Conventions / gotchas

- **No service ownership.** This plugin does not define `DocumentsServiceLike` — it imports it from `@elizaos/agent/api/documents-service-loader`. If the service times out during loading, the route returns 503 with a `Retry-After: 5` header; if the service is simply absent (e.g. agent not running), it returns 503 without that header.
- **Scope defaults.** When no scope is specified on upload, the default is `user-private` for USER role, `agent-private` for AGENT role, and `global` for OWNER/RUNTIME.
- **Bundled and character documents** are read-only: `getDocumentEditability` and `getDocumentDeleteability` enforce this in the presenter, and the PATCH/DELETE handlers check these flags before proceeding.
- **Image upload.** Images are stored as text. If `includeImageDescriptions: true` is passed in the metadata, the handler calls `runtime.useModel(ModelType.IMAGE_DESCRIPTION, ...)` to generate a description. If the model call fails, a warning is included in the response and the stored text explicitly says that image description was unavailable.
- **YouTube URLs.** `POST /api/documents/url` detects YouTube URLs via `isYouTubeUrl()` from `@elizaos/core` and sets `source: "youtube"` in metadata; the transcript is fetched by `fetchDocumentFromUrl()`.
- **Fragment pagination.** Fragment listing always paginates in batches of 500 (`FRAGMENT_BATCH_SIZE`). Large documents with many fragments will issue multiple `getMemories` calls.
- **Max body size.** Single and bulk upload endpoints cap at 32 MB (`DOCUMENT_UPLOAD_MAX_BODY_BYTES`). Bulk is further capped at 100 documents per request.
- **rawPath routing.** All routes are registered with `rawPath: true`, meaning the agent server dispatches them directly without prefix stripping. The path `/api/documents` is absolute.
- **OWNER_DOCUMENTS is host-adapted.** Do not add a second action here unless the PA-hosted approval, scheduler, and document-request behavior is moved with tests that prove parity.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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
