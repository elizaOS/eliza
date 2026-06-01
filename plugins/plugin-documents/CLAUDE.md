# @elizaos/plugin-documents

HTTP API surface for the elizaOS document store.

## Purpose / role

Registers a set of REST routes that expose document CRUD, bulk upload, URL ingestion, semantic search, and fragment listing against the runtime's document store. The plugin delegates all persistence and search to `DocumentsServiceLike` (resolved from `@elizaos/agent/api/documents-service-loader`). It has no actions, providers, evaluators, or event handlers — its sole contribution is HTTP routes.

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

No actions, providers, services, evaluators, or event handlers are registered.

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
test/
  documents-api.live.e2e.test.ts   Live API e2e tests
  documents-live.e2e.test.ts       Live document ingestion e2e tests
```

## Commands

Scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-documents build               # build:js + build:types
bun run --cwd plugins/plugin-documents build:js            # tsup bundling
bun run --cwd plugins/plugin-documents build:types         # tsc --noCheck type emit
bun run --cwd plugins/plugin-documents clean               # rm -rf dist
bun run --cwd plugins/plugin-documents test:e2e:manual     # vitest run live e2e tests
```

No `test`, `lint`, or `typecheck` scripts — use repo-root commands for those.

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
- **Image upload.** Images are stored as text. If `includeImageDescriptions: true` is passed in the metadata, the handler calls `runtime.useModel(ModelType.IMAGE_DESCRIPTION, ...)` to generate a description. If the model call fails, a warning is included in the response and a fallback stub is stored.
- **YouTube URLs.** `POST /api/documents/url` detects YouTube URLs via `isYouTubeUrl()` from `@elizaos/core` and sets `source: "youtube"` in metadata; the transcript is fetched by `fetchDocumentFromUrl()`.
- **Fragment pagination.** Fragment listing always paginates in batches of 500 (`FRAGMENT_BATCH_SIZE`). Large documents with many fragments will issue multiple `getMemories` calls.
- **Max body size.** Single and bulk upload endpoints cap at 32 MB (`DOCUMENT_UPLOAD_MAX_BODY_BYTES`). Bulk is further capped at 100 documents per request.
- **rawPath routing.** All routes are registered with `rawPath: true`, meaning the agent server dispatches them directly without prefix stripping. The path `/api/documents` is absolute.
