---
title: "Documents API"
sidebarTitle: "Knowledge"
description: "REST API endpoints for managing the agent's document corpus — uploading, searching, and deleting documents."
---

The documents API manages the agent's document store and semantic search index. All endpoints require the agent to be running with the documents service available. Documents are automatically chunked into fragments for semantic retrieval.

<Warning>
The URL upload endpoint blocks private/link-local IP addresses and `localhost` for security. YouTube URLs are automatically transcribed via their caption API.
</Warning>

## Endpoints

### GET /api/documents/stats

Get document and fragment counts for the current agent.

**Response**

```json
{
  "documentCount": 42,
  "fragmentCount": 1836,
  "agentId": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### GET /api/documents

List documents with pagination.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Number of results to return (default: 100) |
| `offset` | integer | No | Number of results to skip (default: 0) |

**Response**

```json
{
  "documents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "filename": "research-paper.pdf",
      "contentType": "application/pdf",
      "fileSize": 204800,
      "createdAt": 1718000000000,
      "fragmentCount": 48,
      "source": "upload",
      "url": null
    }
  ],
  "total": 42,
  "limit": 100,
  "offset": 0
}
```

---

### GET /api/documents/:id

Get a specific document including its full content.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Document ID |

**Response**

```json
{
  "document": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "research-paper.pdf",
    "contentType": "application/pdf",
    "fileSize": 204800,
    "createdAt": 1718000000000,
    "fragmentCount": 48,
    "source": "upload",
    "url": null,
    "content": { "text": "Full document text content..." }
  }
}
```

---

### POST /api/documents

Upload a document from base64-encoded content or plain text.

**Request**

```json
{
  "content": "SGVsbG8gV29ybGQ=",
  "filename": "hello.txt",
  "contentType": "text/plain",
  "metadata": { "author": "Alice" }
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Document content — base64-encoded for binary files, plain text for text files |
| `filename` | string | Yes | Original filename including extension |
| `contentType` | string | No | MIME type (default: `text/plain`) |
| `metadata` | object | No | Additional metadata to store with the document |

**Response**

```json
{
  "ok": true,
  "documentId": "550e8400-e29b-41d4-a716-446655440000",
  "fragmentCount": 12
}
```

---

### POST /api/documents/url

Fetch and upload a document from a URL. YouTube URLs are automatically transcribed using their caption API. Redirects, private IPs, and localhost are blocked for security.

**Request**

```json
{
  "url": "https://example.com/document.pdf",
  "metadata": { "source": "web" }
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Public HTTPS URL to fetch. YouTube URLs (youtube.com, youtu.be) are auto-transcribed |
| `metadata` | object | No | Additional metadata to store with the document |

**Response**

```json
{
  "ok": true,
  "documentId": "550e8400-e29b-41d4-a716-446655440000",
  "fragmentCount": 24,
  "filename": "document.pdf",
  "contentType": "application/pdf",
  "isYouTubeTranscript": false
}
```

---

### DELETE /api/documents/:id

Delete a document and all its fragments from the document corpus.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | UUID | Yes | Document ID |

**Response**

```json
{
  "ok": true,
  "deletedFragments": 48
}
```

---

### GET /api/documents/search

Perform semantic search across the document corpus.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | Yes | Search query |
| `threshold` | float | No | Minimum similarity score 0–1 (default: 0.3) |
| `limit` | integer | No | Maximum results to return (default: 20) |

**Response**

```json
{
  "query": "machine learning basics",
  "threshold": 0.3,
  "results": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "text": "Machine learning is a subset of artificial intelligence...",
      "similarity": 0.87,
      "documentId": "550e8400-e29b-41d4-a716-446655440000",
      "documentTitle": "ml-intro.pdf",
      "position": 3
    }
  ],
  "count": 1
}
```

---

### GET /api/documents/:documentId/fragments

List all text fragments for a specific document, ordered by position.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | UUID | Yes | Document ID |

**Response**

```json
{
  "documentId": "550e8400-e29b-41d4-a716-446655440000",
  "fragments": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "text": "Introduction to machine learning...",
      "position": 0,
      "createdAt": 1718000000000
    }
  ],
  "count": 48
}
```

## Bulk Upload

```
POST /api/documents/bulk
```

Uploads up to 100 documents in a single request. Each document is processed independently — partial failures do not abort the batch.

**Request body:**
```json
{
  "documents": [
    {
      "content": "Document text or base64 content",
      "filename": "notes.pdf",
      "contentType": "application/pdf",
      "metadata": {}
    }
  ]
}
```

| Constraint | Value |
|------------|-------|
| Max body size | 32 MB |
| Max documents per request | 100 |

**Response:**
```json
{
  "ok": true,
  "total": 3,
  "successCount": 2,
  "failureCount": 1,
  "results": [
    {
      "index": 0,
      "ok": true,
      "filename": "notes.pdf",
      "documentId": "550e8400-e29b-41d4-a716-446655440000",
      "fragmentCount": 14,
      "warnings": []
    },
    {
      "index": 1,
      "ok": false,
      "filename": "broken.txt",
      "error": "content and filename must be non-empty strings"
    }
  ]
}
```

Top-level `ok` is `true` only when `failureCount === 0`. `warnings` is present only on successful items when the ingestion emitted warnings.

**Errors:** `400` if `documents` is missing, empty, or exceeds 100 items.

## Service availability

All documents endpoints require the documents service to be loaded. If the service is still initializing (for example, during agent startup), requests return a `503` with a `Retry-After` header:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
Content-Type: application/json

{
  "error": "Documents service is still loading. Please retry shortly."
}
```

The `Retry-After` value is `5` (seconds). Clients should wait at least that long before retrying. The service typically finishes loading within 10 seconds of agent startup (configurable via the `DOCUMENTS_SERVICE_TIMEOUT_MS` environment variable, maximum 60 seconds).

If the documents service is unavailable for a reason other than a loading timeout (for example, the agent is not running), the response is `503` without a `Retry-After` header:

```json
{
  "error": "Documents service is not available. Agent may not be running."
}
```

## Common error codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 413 | `PAYLOAD_TOO_LARGE` | Request body exceeds maximum size limit (32 MB for bulk upload) |
| 500 | `EMBEDDING_FAILED` | Failed to generate embeddings for document content |
| 500 | `DOCUMENT_TOO_LARGE` | Document content is too large to process |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 503 | `SERVICE_UNAVAILABLE` | Documents service is still loading or not available — check `Retry-After` header |
