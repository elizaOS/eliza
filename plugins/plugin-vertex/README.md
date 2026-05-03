# @elizaos/plugin-vertex

Google Vertex AI plugin for ElizaOS — run any models through your GCP account.

## Why

Use your GCP billing instead of any LLM API keys. Same Claude models, routed through Google's Vertex AI infrastructure.

## Setup

1. Enable the Vertex AI API in your GCP project
2. Set up authentication (Application Default Credentials or service account)
3. Configure environment variables:

```env
GOOGLE_VERTEX_PROJECT_ID=your-gcp-project-id
GOOGLE_VERTEX_REGION=us-east5
```

## Models

| ModelType | Default | Override |
|---|---|---|
| TEXT_SMALL | claude-haiku-4-5@20251001 | `VERTEX_SMALL_MODEL` |
| TEXT_LARGE | claude-sonnet-4-6@20250514 | `VERTEX_LARGE_MODEL` |
| TEXT_REASONING_SMALL | claude-sonnet-4-6@20250514 | `VERTEX_REASONING_SMALL_MODEL` |
| TEXT_REASONING_LARGE | claude-opus-4-6@20250620 | `VERTEX_REASONING_LARGE_MODEL` |
| OBJECT_SMALL | (uses TEXT_SMALL model) | - |
| OBJECT_LARGE | (uses TEXT_LARGE model) | - |

## Usage

```typescript
import { vertexPlugin } from "@elizaos/plugin-vertex";

const agent = new AgentRuntime({
  plugins: [vertexPlugin],
  // ...
});
```

## Authentication

Uses Google Application Default Credentials. Options:
- `gcloud auth application-default login` (local dev)
- Service account key via `GOOGLE_APPLICATION_CREDENTIALS` env var
- Workload Identity (GKE, Cloud Run)
