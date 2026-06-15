# @elizaos/plugin-documents

Adds a document management REST API to an elizaOS agent.

## What it does

This plugin registers HTTP routes on the agent server that let clients (the dashboard UI, other agents, and external tools) upload, retrieve, search, edit, and delete documents from the agent's document store.

Documents are stored as memories in the runtime's `documents` table and chunked into fragments in the `document_fragments` table for vector/semantic search. The plugin handles:

- Uploading text files, markdown, JSON, CSV, images, and other content types
- Fetching and ingesting content from arbitrary URLs or YouTube transcripts
- Bulk uploading up to 100 documents in a single request
- Semantic, keyword, and hybrid search across document fragments
- Listing fragments for a document (ordered by position)
- Editing text-backed documents (replaces content and re-fragments)
- Deleting documents and their fragments
- Access control: `global`, `owner-private`, `user-private`, and `agent-private` document scopes

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/documents` | List documents; supports `scope`, `addedBy`, `tags`, `timeRangeStart/End`, `q` query, `limit`, `offset` |
| GET    | `/api/documents/stats` | Document and fragment counts |
| GET    | `/api/documents/search` | Semantic/keyword/hybrid search; params: `q`, `threshold`, `limit`, `searchMode` |
| GET    | `/api/documents/:id` | Fetch a document with full content |
| GET    | `/api/documents/:id/fragments` | List all text fragments ordered by position |
| POST   | `/api/documents` | Upload a document: `{ content, filename, contentType?, metadata?, scope?, ... }` |
| POST   | `/api/documents/bulk` | Upload up to 100 documents at once |
| POST   | `/api/documents/url` | Ingest a URL or YouTube transcript: `{ url, scope?, metadata? }` |
| PATCH  | `/api/documents/:id` | Update document text (only for non-bundled, non-character, text-backed documents) |
| DELETE | `/api/documents/:id` | Delete document and all its fragments |

## Document scopes

| Scope | Who can read/write |
|-------|--------------------|
| `global` | Anyone; only OWNER/RUNTIME can write |
| `owner-private` | OWNER and RUNTIME only |
| `user-private` | Scoped to a specific user entity |
| `agent-private` | OWNER, AGENT, and RUNTIME |

The caller's role is resolved from the `x-eliza-entity-id` / `x-eliza-actor-entity-id` request headers and the `ELIZA_ADMIN_ENTITY_ID` runtime setting.

## Configuration

No additional environment variables are required beyond those needed by the document storage service (`@elizaos/agent`). The plugin uses `ELIZA_ADMIN_ENTITY_ID` (read from the agent runtime settings) to identify the owner actor for access control decisions.

## Enabling the plugin

Add `@elizaos/plugin-documents` to the agent's plugin list in the character configuration or register it programmatically:

```typescript
import { documentsPlugin } from "@elizaos/plugin-documents";

const character = {
  plugins: ["@elizaos/plugin-documents"],
  // ...
};
```

## Limitations

- Image uploads are converted to text descriptions when `includeImageDescriptions: true` is set in metadata (requires a vision model). Without a generated description, the stored text explicitly records that text extraction or image description was unavailable.
- Bundled documents (seeded by the runtime) and character documents (from character source files) cannot be edited or deleted through this API.
- Bulk upload is capped at 100 documents per request; individual upload bodies are capped at 32 MB.
