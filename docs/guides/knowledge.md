---
title: Knowledge Base (RAG)
sidebarTitle: Knowledge
description: Upload documents, URLs, and YouTube transcripts to build a searchable knowledge base the agent uses for Retrieval Augmented Generation.
---

The knowledge system provides Retrieval Augmented Generation (RAG) for the Milady agent. You can upload documents, URLs, and YouTube videos to build a searchable knowledge base. When the agent responds to questions, it retrieves relevant fragments from this knowledge base to ground its answers in your specific content.

## Architecture Overview

The knowledge system is built on three layers:

1. **Storage layer** -- Documents and fragments are stored as memory records in the agent's database. The system uses two memory tables: `documents` for the original uploads and `knowledge` for the individual text fragments. Each fragment carries a vector embedding that enables semantic search.
2. **Service layer** -- The `knowledge` service registers with the agent runtime and exposes `addKnowledge` and `getKnowledge` methods. When the service is still loading at startup, API requests wait up to 10 seconds for it to become available before returning a 503 error.
3. **Provider layer** -- The `knowledgeProvider` is a context provider that runs automatically during message processing. It takes the current message, performs a semantic similarity search against all stored fragments, and injects the most relevant results into the agent's context window before the LLM generates a response.

```
User uploads document
       |
       v
  Knowledge Service
       |
       ├── Splits content into fragments
       ├── Generates vector embeddings for each fragment
       └── Stores document + fragments in the database
                    |
                    v
           Agent receives a message
                    |
                    v
           Knowledge Provider
                    |
                    ├── Embeds the query
                    ├── Searches for similar fragments
                    └── Injects top matches into LLM context
                              |
                              v
                    Agent generates response
```

## How It Works

1. **Upload** -- Documents are uploaded via the API or dashboard. Supported sources include file uploads (text, PDF, Word documents), web URLs, and YouTube videos (auto-transcribed).
2. **Chunking** -- The knowledge service splits uploaded content into smaller text fragments. The core uses a `splitChunks` utility that divides content into chunks with a configurable size and an overlap ("bleed") between adjacent chunks so that context is not lost at chunk boundaries.
3. **Embedding** -- Each fragment is passed through an embedding model (provided by whichever LLM backend you have configured, such as OpenAI or Anthropic) to produce a vector representation. These vectors are stored alongside the fragment text.
4. **Retrieval** -- When the agent processes a message, the knowledge provider creates a vector embedding of the incoming query and performs a cosine similarity search against all stored fragment vectors.
5. **Generation** -- The highest-scoring fragments (above the similarity threshold) are injected into the agent's context, allowing it to generate responses grounded in your uploaded content.

## Supported File Types

The knowledge system accepts a wide range of document formats. The dashboard file picker and drag-and-drop zone accept the following extensions:

| Format | Extensions | Content Type | Handling |
|--------|-----------|-------------|----------|
| Plain text | `.txt` | `text/plain` | Stored as-is |
| Markdown | `.md` | `text/markdown` | Stored as-is |
| PDF | `.pdf` | `application/pdf` | Base64-encoded, parsed server-side |
| Word | `.docx` | `application/vnd.openxmlformats-officedocument...` | Base64-encoded, parsed server-side |
| JSON | `.json` | `application/json` | Stored as text |
| CSV | `.csv` | `text/csv` | Stored as text |
| XML | `.xml` | `application/xml` | Stored as text |
| HTML | `.html` | `text/html` | Stored as text |
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | `image/*` | Base64-encoded; optional AI description extraction |

Text-based formats (plain text, Markdown, HTML, CSV, JSON, XML) are read directly as UTF-8 strings. Binary formats (PDF, Word, images) are read as `ArrayBuffer` and converted to base64 before sending to the server.

When uploading images, you can enable the "Include AI image descriptions" option. This uses a vision model to generate a textual description of the image content, which is then stored and indexed as knowledge. This increases embedding and vision API costs but provides richer searchable context.

## How Documents Are Chunked and Embedded

### Chunking

The core `splitChunks` function divides document text into overlapping segments:

```
splitChunks(content: string, chunkSize?: number, bleed?: number): Promise<string[]>
```

- **chunkSize** -- The target number of characters per fragment. Larger chunks preserve more context per fragment but reduce retrieval precision.
- **bleed** -- The number of overlapping characters between adjacent chunks. This overlap ensures that information spanning a chunk boundary is captured in at least one fragment.

Each chunk becomes a separate fragment record in the `knowledge` table with a `position` field indicating its order within the original document and a `documentId` linking it back to the parent document.

### Embedding

After chunking, each fragment is passed through the embedding model configured in your LLM provider (e.g., OpenAI `text-embedding-ada-002`, or the embedding endpoint of your chosen provider). The resulting vector is stored in the database alongside the fragment text. The embedding model must be available in the agent runtime -- if you are using OpenAI, your `OPENAI_API_KEY` environment variable must be set; for Anthropic, `ANTHROPIC_API_KEY`; for Groq, `GROQ_API_KEY`.

### Memory Types

The core runtime defines several memory types:

| Type | Table | Purpose |
|------|-------|---------|
| `document` | `documents` | The original uploaded document record with metadata |
| `fragment` | `knowledge` | A chunk of a document with its vector embedding |
| `message` | `messages` | Conversational messages from users and the agent |
| `description` | `descriptions` | Descriptive information about entities or concepts |

Documents and fragments are linked by the `documentId` field in the fragment's metadata.

## Upload Types

### File Upload

Upload document content directly as text or base64-encoded binary data.

**POST `/api/knowledge/documents`**

```json
{
  "content": "The full text content or base64-encoded binary data",
  "filename": "my-document.txt",
  "contentType": "text/plain",
  "metadata": {
    "source": "manual",
    "category": "reference"
  }
}
```

Supported content types include plain text, PDF (`application/pdf`), Word documents (`application/vnd.openxmlformats-officedocument`), and images. Binary content should be base64-encoded. The maximum upload size is 32 MB. The dashboard shows a warning when files exceed 8 MB to alert you about potential cost implications for embedding and vision processing.

### URL Upload

Fetch and index content from a web URL.

**POST `/api/knowledge/documents/url`**

```json
{
  "url": "https://example.com/article",
  "metadata": {
    "category": "web"
  }
}
```

The system fetches the URL content, detects its type, and processes it appropriately. Text content is stored directly; binary content (PDF, Word, images) is stored as base64. The User-Agent header identifies the request as `Mozilla/5.0 (compatible; Milady/1.0; +https://milady.ai)`.

#### Security: SSRF Protection

URL fetching includes comprehensive SSRF (Server-Side Request Forgery) protection:

- **Blocked hosts** -- Requests to `localhost` and `metadata.google.internal` are rejected outright.
- **Blocked IP ranges** -- Private network addresses (10.x.x.x, 172.16-31.x.x, 192.168.x.x), loopback addresses (127.x.x.x), link-local ranges (169.254.x.x, fe80::/10), and cloud metadata endpoints (169.254.169.254) are all blocked.
- **DNS resolution check** -- Before fetching, the system resolves the hostname and checks that none of the resolved IP addresses fall into blocked ranges. This prevents DNS rebinding attacks where a public hostname resolves to a private IP.
- **Redirect blocking** -- HTTP redirects are blocked entirely (`redirect: "manual"`). If the server responds with a 3xx redirect, the request is rejected. This prevents an attacker from redirecting through a public URL to an internal resource.
- **Protocol restriction** -- Only `http://` and `https://` URLs are accepted.

### YouTube Transcripts

YouTube URLs are automatically detected and handled specially. Instead of fetching the page HTML, the system:

1. Extracts the video ID from the URL (supports `youtube.com/watch`, `youtu.be`, `/embed/`, and `/v/` formats)
2. Fetches the video page to locate caption track URLs
3. Downloads and parses the timed text XML transcript
4. Decodes HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`) in each caption segment
5. Joins all segments with spaces and stores the full transcript as plain text

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
}
```

The response includes `isYouTubeTranscript: true` to confirm transcript extraction and metadata with `source: "youtube"`. If captions are not available for the video, the request fails with an error.

## Searching the Knowledge Base

### Semantic Search

**GET `/api/knowledge/search?q=<query>&threshold=0.3&limit=20`**

Search across all knowledge fragments using semantic similarity. The system creates a vector embedding of the query text and finds the most similar fragment vectors using cosine similarity.

Query parameters:
- `q` (required) -- search query text
- `threshold` -- minimum similarity score (0 to 1, default: 0.3). Higher values return only very close matches; lower values cast a wider net.
- `limit` -- maximum results to return (default: 20)

```json
{
  "query": "how to configure triggers",
  "threshold": 0.3,
  "results": [
    {
      "id": "fragment-uuid",
      "text": "Triggers are scheduled tasks that wake the agent...",
      "similarity": 0.87,
      "documentId": "document-uuid",
      "documentTitle": "triggers-guide.md",
      "position": 3
    }
  ],
  "count": 5
}
```

Results are filtered by the threshold, sorted by similarity score (descending), and limited to the specified count. Each result includes the fragment text, a similarity score between 0 and 1, a reference to the parent document, and the fragment's position within that document.

### How RAG Retrieval Works at Runtime

During normal conversation, the knowledge provider runs automatically. You do not need to call the search API manually. The flow is:

1. A user sends a message to the agent.
2. The runtime invokes the `knowledgeProvider`, which calls `getKnowledge` with the message content.
3. `getKnowledge` embeds the message text and performs a vector similarity search across all fragments scoped to the agent.
4. The top matching fragments are formatted and appended to the agent's system context.
5. The LLM generates a response with access to the retrieved knowledge.

The provider scopes knowledge retrieval by `roomId`, `worldId`, and `entityId` to ensure the agent only accesses knowledge appropriate to the current context.

## Managing Knowledge

### View Statistics

**GET `/api/knowledge/stats`**

Returns the total number of documents and fragments for the current agent:

```json
{
  "documentCount": 15,
  "fragmentCount": 342,
  "agentId": "agent-uuid"
}
```

### List Documents

**GET `/api/knowledge/documents?limit=100&offset=0`**

Returns documents with their metadata and fragment counts. Fragment counts are computed by scanning the `knowledge` table in batches of 500 and counting fragments whose `documentId` matches each document:

```json
{
  "documents": [
    {
      "id": "document-uuid",
      "filename": "my-guide.pdf",
      "contentType": "application/pdf",
      "fileSize": 245760,
      "createdAt": 1706000000000,
      "fragmentCount": 23,
      "source": "upload",
      "url": null
    }
  ],
  "total": 15,
  "limit": 100,
  "offset": 0
}
```

Metadata fields are normalized with sensible defaults: `filename` falls back to the document title or "Untitled"; `contentType` falls back to "unknown"; `fileSize` and `createdAt` default to 0 when missing.

### Get Document Detail

**GET `/api/knowledge/documents/:id`**

Returns a single document with full content, metadata, and fragment count.

### View Document Fragments

**GET `/api/knowledge/fragments/:documentId`**

Returns all fragments for a specific document, sorted by position. The endpoint paginates internally in batches of 500 to handle large document sets:

```json
{
  "documentId": "document-uuid",
  "fragments": [
    {
      "id": "fragment-uuid",
      "text": "The first section of the document...",
      "position": 0,
      "createdAt": 1706000000000
    }
  ],
  "count": 23
}
```

Fragments with missing `id` or `createdAt` values are filtered out of the response.

### Delete Document

**DELETE `/api/knowledge/documents/:id`**

Deletes a document and all its associated fragments. The system first identifies all fragments belonging to the document, deletes each one individually, then deletes the document record itself:

```json
{
  "ok": true,
  "deletedFragments": 23
}
```

## API Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/knowledge/stats` | Document and fragment counts |
| GET | `/api/knowledge/documents` | List all documents (paginated) |
| GET | `/api/knowledge/documents/:id` | Get a single document with content |
| POST | `/api/knowledge/documents` | Upload document from content |
| POST | `/api/knowledge/documents/url` | Upload document from URL |
| DELETE | `/api/knowledge/documents/:id` | Delete document and fragments |
| GET | `/api/knowledge/search?q=...` | Semantic search across fragments |
| GET | `/api/knowledge/fragments/:documentId` | List fragments for a document |

## The Knowledge Tab in the Dashboard

The `KnowledgeView` component in the dashboard provides a full visual interface for managing the knowledge base without using the API directly.

### Stats Display

At the top of the view, two cards show the total document count and fragment count. The fragment count card includes a tooltip explaining that "Documents are split into smaller text chunks called fragments for efficient search and context retrieval."

### Document Upload

The upload zone supports two input methods:

- **File picker** -- Click "Choose File" to open the system file dialog. Accepts `.txt`, `.md`, `.pdf`, `.docx`, `.json`, `.csv`, `.xml`, `.html`, `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif` files.
- **Drag-and-drop** -- Drop a file anywhere on the upload zone. The zone highlights with an accent border during drag-over.

A checkbox labeled "Include AI image descriptions (more context, may increase cost)" controls whether uploaded images are analyzed by a vision model. This is enabled by default.

The dashboard shows a confirmation dialog for files larger than 8 MB, warning that "Large uploads can take longer and may increase embedding/vision costs." The hard limit is 32 MB -- uploads exceeding this are rejected with a payload size error.

### URL Upload

Click "Add from URL" to reveal a text input. Paste any URL and press Enter or click "Import." YouTube links are automatically detected and the transcript is extracted instead of the page HTML. The URL input field shows a hint: "Paste a URL to import content. YouTube links will be auto-transcribed."

### Search

The search bar accepts free-text queries. Results appear below with:

- The source document title
- A percentage match score (similarity * 100, rounded)
- A preview of the matching fragment text (limited to 3 lines)

Click "Clear" to dismiss search results and return to the document list.

### Document List

All uploaded documents appear in a scrollable list showing:

- Filename (truncated if long)
- Content type, file size, and upload date
- Source badges: a red "YouTube" badge for transcripts, an accent-colored "URL" badge for web imports
- A delete button with confirmation

Click any document to open the detail modal.

### Document Detail Modal

The modal shows:

- Document metadata (content type, source, URL if applicable)
- A numbered list of all fragments with their position and full text, rendered in a scrollable container

## Character-Level Knowledge

In addition to runtime uploads, Milady agents can have knowledge baked into their character definition. The character's `knowledge` array supports two source types:

- **File path** -- A path to a specific file on disk. The content is loaded, chunked, and embedded when the agent starts.
- **Directory** -- A path to a directory. All supported files in the directory are processed. Directories can be marked as `shared: true` to share knowledge across multiple agents.

```json
{
  "knowledge": [
    { "item": { "case": "path", "value": "./docs/product-guide.md" } },
    { "item": { "case": "directory", "value": { "path": "./knowledge-base", "shared": true } } }
  ]
}
```

Character-level knowledge is loaded at agent startup and persists across restarts.

## Memory vs. Knowledge

Milady maintains two distinct information systems:

| Aspect | Memory | Knowledge |
|--------|--------|-----------|
| **Source** | Conversations, observations, interactions | Uploaded documents, URLs, transcripts |
| **Created by** | Automatically during agent operation | Explicitly by the user via API or dashboard |
| **Storage** | `messages`, `descriptions` tables | `documents`, `knowledge` tables |
| **Retrieval** | Recent conversation history, relationship descriptions | Semantic similarity search (RAG) |
| **Scope** | Per-room, per-entity conversation context | Agent-wide or scoped by room/world/entity |
| **Persistence** | Grows over time with use | Remains until explicitly deleted |
| **Purpose** | Conversational continuity and relationship tracking | Grounding responses in specific reference material |

Both systems contribute to the agent's context during response generation, but they serve different roles. Memory provides conversational awareness ("what did we discuss?"), while knowledge provides factual grounding ("what does the documentation say?").

## Performance and Limits

### Upload Limits

- **Maximum request payload**: 32 MB (enforced both client-side and server-side)
- **Large file warning threshold**: 8 MB (dashboard shows a confirmation dialog)
- **Concurrent uploads**: One at a time in the dashboard (the upload zone is disabled during an active upload)

### Search Performance

- Semantic search performance depends on the number of fragments and the database backend. PGLite (the default local database) stores embeddings in-memory and performs brute-force cosine similarity. PostgreSQL with the pgvector extension can use approximate nearest neighbor indexes for faster search at scale.
- The default similarity threshold of 0.3 provides a good balance between recall and precision. Set it higher (0.5-0.7) for stricter matches or lower (0.1-0.2) for broader retrieval.
- The default result limit of 20 fragments is usually sufficient. The fragments are injected into the LLM context window, so very large result sets can consume significant context.

### Fragment Pagination

Internal operations (listing documents, counting fragments, deleting documents) use a batch size of 500. For documents with thousands of fragments, the system automatically paginates through multiple batches. This ensures stable memory usage but means that listing all fragments for a very large document may require multiple internal queries.

### Service Availability

The knowledge service loads asynchronously when the agent starts. If the API receives a knowledge request before the service is ready, it waits up to 10 seconds for the service to load. If the service does not become available within that window, the API returns a 503 "Knowledge service is not available" error. This typically only occurs during cold starts of the agent.
