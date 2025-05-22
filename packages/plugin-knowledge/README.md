# Knowledge Plugin for ElizaOS

This plugin provides Retrieval Augmented Generation (Knowledge) capabilities for ElizaOS agents, allowing them to load, index, and query knowledge from various sources.

## Quick Setup

### Basic Setup (With plugin-openai)

If you already have plugin-openai configured, you don't need any additional environment variables! The Knowledge plugin will automatically use your OpenAI configuration.

1. Make sure you have plugin-openai configured with:

   ```env
   OPENAI_API_KEY=your-openai-api-key
   OPENAI_EMBEDDING_MODEL=text-embedding-3-small
   ```

2. Add the Knowledge plugin to your agent's configuration
3. That's it! The plugin will work without any additional variables

### Enabling Contextual Knowledge

If you want enhanced Knowledge capabilities with contextual embeddings, add:

```env
# Enable contextual Knowledge
CTX_KNOWLEDGE_ENABLED=true

# Required text generation settings
TEXT_PROVIDER=openrouter  # Choose your provider: openai, anthropic, openrouter, or google
TEXT_MODEL=anthropic/claude-3.5-sonnet  # Model for your chosen provider

# Provider-specific API key (based on TEXT_PROVIDER)
OPENROUTER_API_KEY=your-openrouter-api-key
# OR ANTHROPIC_API_KEY=your-anthropic-api-key
# OR GOOGLE_API_KEY=your-google-api-key
# OR use existing OPENAI_API_KEY
```

### Custom Embedding Configuration (Without plugin-openai)

If you're not using plugin-openai or want to use different embedding settings:

```env
# Required embedding settings
EMBEDDING_PROVIDER=openai  # or google
TEXT_EMBEDDING_MODEL=text-embedding-3-small

# Provider-specific API key
OPENAI_API_KEY=your-openai-api-key  # if using openai
# OR GOOGLE_API_KEY=your-google-api-key  # if using google

# Optional: Custom embedding dimension
EMBEDDING_DIMENSION=1536
```

## Advanced Configuration

### Recommended Configurations for Contextual Knowledge

For optimal performance with contextual Knowledge, we recommend these provider combinations:

**Option 1: OpenRouter with Claude/Gemini (Best for cost efficiency)**

```env
# If using with plugin-openai, only need these additions:
CTX_KNOWLEDGE_ENABLED=true
TEXT_PROVIDER=openrouter
TEXT_MODEL=anthropic/claude-3.5-sonnet  # or google/gemini-2.5-flash-preview
OPENROUTER_API_KEY=your-openrouter-api-key
```

**Option 2: OpenAI for Everything**

```env
# If using with plugin-openai, only need these additions:
CTX_KNOWLEDGE_ENABLED=true
TEXT_PROVIDER=openai
TEXT_MODEL=gpt-4o
```

**Option 3: Google AI for Everything**

```env
EMBEDDING_PROVIDER=google
TEXT_EMBEDDING_MODEL=text-embedding-004
TEXT_PROVIDER=google
TEXT_MODEL=gemini-1.5-pro-latest
GOOGLE_API_KEY=your-google-api-key
CTX_KNOWLEDGE_ENABLED=true
```

### Advanced Rate Limiting Options

```env
# Rate limiting (optional)
MAX_CONCURRENT_REQUESTS=30  # Default: 30
REQUESTS_PER_MINUTE=60      # Default: 60
TOKENS_PER_MINUTE=150000    # Default: 150000
```

### Custom API Endpoints

```env
# Only needed if using custom API endpoints
OPENAI_BASE_URL=https://your-openai-proxy.com/v1
ANTHROPIC_BASE_URL=https://your-anthropic-proxy.com
OPENROUTER_BASE_URL=https://your-openrouter-proxy.com/api/v1
GOOGLE_BASE_URL=https://your-google-proxy.com
```

### Token Limits

```env
# Advanced token handling (optional)
MAX_INPUT_TOKENS=4000   # Default: 4000
MAX_OUTPUT_TOKENS=4096  # Default: 4096
```

## Architecture

The plugin is built with a modular, clean architecture that follows SOLID principles:

```
packages/plugin-knowledge/
├── src/
│   ├── index.ts           # Main entry point and plugin definition
│   ├── service.ts         # Knowledge service implementation
│   ├── types.ts           # Type definitions
│   ├── llm.ts             # LLM interactions (text generation, embeddings)
│   ├── config.ts          # Configuration validation
│   ├── ctx-embeddings.ts  # Contextual embedding generation
│   ├── document-processor.ts # Shared document processing utilities
│   └── utils.ts           # Utility functions
├── README.md              # This file
└── package.json           # Package definition
```

### Database-Specific Processing Paths

The Knowledge plugin adapts to the database technology being used:

1. **PostgreSQL Mode**: Uses worker threads to offload document processing from the main thread
2. **PGLite Mode**: Uses synchronous processing in the main thread due to PGLite's single-threaded nature

This allows the plugin to work optimally with both databases while maintaining the same functionality.

### Processing Flow

The document processing flow follows these steps regardless of database type:

1. Extract text from the document based on content type
2. Store the main document in the database
3. Split the document into chunks
4. Generate embeddings for each chunk (with optional context enrichment)
5. Store the chunks with embeddings in the database

## Component Overview

- **KnowledgeService**: Core service that manages document processing and storage
- **Document Processor**: Provides shared document processing utilities for both processing paths

## Features

- Document upload and processing (PDF, text, and other formats)
- Contextual chunking and embedding generation
- Robust error handling and recovery
- Rate limiting to respect provider limitations
- Support for multiple LLM providers

## Usage

### Basic Usage

```typescript
import { KnowledgeService } from '@elizaos/plugin-knowledge';

// Add knowledge to an agent
const result = await knowledgeService.addKnowledge({
  clientDocumentId: 'unique-id',
  content: documentContent, // Base64 string for binary files or plain text for text files
  contentType: 'application/pdf',
  originalFilename: 'document.pdf',
  worldId: 'world-id',
  roomId: 'optional-room-id', // Optional scoping
  entityId: 'optional-entity-id', // Optional scoping
});

console.log(`Document stored with ID: ${result.storedDocumentMemoryId}`);
console.log(`Created ${result.fragmentCount} searchable fragments`);
```

## License

See the ElizaOS license for details.
