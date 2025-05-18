# RAG Plugin for ElizaOS

This plugin provides Retrieval Augmented Generation (RAG) capabilities for ElizaOS agents, allowing them to load, index, and query knowledge from various sources.

## Architecture

The plugin is built with a modular, clean architecture that follows SOLID principles:

```
packages/plugin-rag/
├── src/
│   ├── index.ts           # Main entry point and plugin definition
│   ├── service.ts         # RAG service implementation
│   ├── worker.ts          # Worker thread management
│   ├── rag-worker.ts      # Worker implementation for processing docs
│   ├── types.ts           # Type definitions
│   ├── llm.ts             # LLM interactions (text generation, embeddings)
│   ├── config.ts          # Configuration validation
│   ├── ctx-embeddings.ts  # Contextual embedding generation
│   └── utils.ts           # Utility functions
├── README.md              # This file
└── package.json           # Package definition
```

## Component Overview

- **RagService**: Core service that manages document processing and storage
- **WorkerManager**: Handles worker lifecycle and communication
- **Worker Implementation**: Processes documents, creates embeddings, and chunks text

## Features

- Document upload and processing (PDF, text, and other formats)
- Contextual chunking and embedding generation
- Parallel processing via worker threads
- Robust error handling and recovery
- Rate limiting to respect provider limitations
- Support for multiple LLM providers

## Usage

### Basic Usage

```typescript
import { RagService } from '@elizaos/plugin-rag';

// Add knowledge to an agent
await ragService.addKnowledge({
  clientDocumentId: 'unique-id',
  fileBuffer: documentBuffer,
  contentType: 'application/pdf',
  originalFilename: 'document.pdf',
  worldId: 'world-id',
  onDocumentStored: (error, result) => {
    if (error) {
      console.error('Error storing document:', error);
      return;
    }
    console.log('Document stored:', result);
  },
});
```

### Configuration

The plugin has two main operating modes that affect which configuration variables are required:

#### Basic Embedding Mode (CTX_RAG_ENABLED=false)

When contextual RAG is disabled, the plugin only requires embedding configuration:

```env
# Basic embedding-only configuration (minimum required)
EMBEDDING_PROVIDER=openai
TEXT_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=your-openai-api-key

# Optional: Embedding dimension (default: 1536)
EMBEDDING_DIMENSION=1536
```

**Important**: In this mode, TEXT_PROVIDER and TEXT_MODEL are not required. The EMBEDDING_PROVIDER and TEXT_EMBEDDING_MODEL should match your ElizaOS configuration to ensure compatibility. For instance, if your ElizaOS uses OpenAI for embeddings, you should configure this plugin to use OpenAI as well.

This mode uses simple text splitting without contextual enrichment. Documents are chunked, but each chunk's embedding is generated without additional context from the full document.

#### Contextual RAG Mode (CTX_RAG_ENABLED=true)

When contextual RAG is enabled, both embedding and text generation configurations are required:

```env
# Comprehensive configuration for Contextual RAG

# Required embedding settings
EMBEDDING_PROVIDER=openai
TEXT_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=your-openai-api-key

# Required text generation settings (only when CTX_RAG_ENABLED=true)
TEXT_PROVIDER=openrouter
TEXT_MODEL=google/gemini-2.5-flash-preview
OPENROUTER_API_KEY=your-openrouter-api-key

# Optional base URLs if using custom endpoints
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Enable contextual RAG
CTX_RAG_ENABLED=true

# Optional: Customize dimensions and token limits
EMBEDDING_DIMENSION=1536
MAX_INPUT_TOKENS=4000
MAX_OUTPUT_TOKENS=4096
```

**Note**: TEXT_PROVIDER and TEXT_MODEL are only required when CTX_RAG_ENABLED is set to true. The embedding dimension and model should match your ElizaOS configuration for optimal compatibility.

#### Recommended Configurations

For optimal contextual RAG performance, we recommend the following provider combinations:

**Option 1: OpenRouter with Claude/Gemini**

```env
EMBEDDING_PROVIDER=openai
TEXT_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=your-openai-api-key

TEXT_PROVIDER=openrouter
TEXT_MODEL=anthropic/claude-3.5-sonnet
# or TEXT_MODEL=google/gemini-2.5-flash-preview
OPENROUTER_API_KEY=your-openrouter-api-key
CTX_RAG_ENABLED=true
```

This setup enables document caching for improved performance and reduced costs.

**Option 2: OpenAI for Everything**

```env
EMBEDDING_PROVIDER=openai
TEXT_EMBEDDING_MODEL=text-embedding-3-small
TEXT_PROVIDER=openai
TEXT_MODEL=gpt-4o
OPENAI_API_KEY=your-openai-api-key
CTX_RAG_ENABLED=true
```

**Option 3: Google AI for Everything**

```env
EMBEDDING_PROVIDER=google
TEXT_EMBEDDING_MODEL=text-embedding-004
TEXT_PROVIDER=google
TEXT_MODEL=gemini-1.5-pro-latest
GOOGLE_API_KEY=your-google-api-key
CTX_RAG_ENABLED=true
```

#### Advanced Configuration Options

| Variable                  | Description                     | Default | Required? |
| ------------------------- | ------------------------------- | ------- | --------- |
| `EMBEDDING_DIMENSION`     | Dimension of embedding vectors  | 1536    | No        |
| `MAX_INPUT_TOKENS`        | Maximum tokens for model input  | 4000    | No        |
| `MAX_OUTPUT_TOKENS`       | Maximum tokens for model output | 4096    | No        |
| `MAX_CONCURRENT_REQUESTS` | Maximum concurrent API requests | 30      | No        |
| `REQUESTS_PER_MINUTE`     | Rate limit for API requests     | 60      | No        |

## Development

### Adding a new feature

1. Identify which module the feature belongs to
2. Add necessary types to types.ts
3. Implement the feature in the appropriate module
4. Update the service or worker if needed
5. Export any new public API from index.ts

### Design Principles

- **Single Responsibility**: Each module has a clear, focused responsibility
- **DRY (Don't Repeat Yourself)**: Common functionality is extracted into helper functions
- **KISS (Keep It Simple, Stupid)**: Code is straightforward and avoids unnecessary complexity
- **Composition over Inheritance**: Modules are composed together rather than inheriting
- **Strong Typing**: TypeScript type safety is used throughout

## Testing

Tests can be run with:

```bash
npm test
```

## License

See the ElizaOS license for details.
