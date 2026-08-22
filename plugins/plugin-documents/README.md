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
| PATCH  | `/api/documents/:id/access` | Replace explicit entity read grants (OWNER or current room ADMIN) |
| GET    | `/api/documents/:id/access` | Read explicit entity grants under the same management authority |
| DELETE | `/api/documents/:id` | Delete document and all its fragments |

## Document scopes

| Scope | Who can read/write |
|-------|--------------------|
| `global` | Anyone; only OWNER/RUNTIME can write |
| `owner-private` | OWNER and RUNTIME only |
| `user-private` | Scoped to a specific user entity |
| `agent-private` | OWNER, AGENT, and RUNTIME |

The caller's role comes from the authenticated `AccessContext` supplied by the
host route boundary. A request without that context returns `401`; request
headers and `ELIZA_ADMIN_ENTITY_ID` never create an authenticated caller. Roles
remain exact at this boundary: ADMIN is not OWNER, GUEST is not USER, and an
unresolved role is rejected. Guests may read global documents in rooms where
they are current members, but cannot read private scopes or mutate documents.
List, facet, search, single-document, and fragment reads are resolved by
`DocumentService` with that authenticated context. Routes never fetch a parent
row, scan the document tables, or rank search results and then attempt to apply
authorization locally. List pagination and facet counts are constructed only
from the service-authorized set; fragment counts use the authorized parent and
fragment path.
PATCH and DELETE resolve mutation authority through the same service. Deletes
use the adapter's atomic snapshot operation instead of route-managed fragment
and parent deletion.
Direct grants are independent of room membership for reads, but never grant
mutation authority and never open `agent-private` documents. Grant replacement
is atomic, validates every entity against the current agent, and is limited to
OWNER or a current room ADMIN for `global` and `user-private` documents.

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
