# Eliza OS Plugin: RAG

This plugin provides Retrieval Augmented Generation (RAG) capabilities for Eliza OS agents, enabling them to retrieve and incorporate relevant information from a knowledge base when responding to queries.

## Features

- Text embedding generation using multiple providers (OpenAI, Google)
- Text generation using multiple providers (OpenAI, Anthropic, OpenRouter, Google)
- Document processing and chunking
- Knowledge base management
- Support for contextual RAG (improved chunking with LLM-enhanced context)

## Configuration

The plugin supports multiple AI service providers and can be configured using environment variables:

### Required Settings

```env
# Provider selection
EMBEDDING_PROVIDER=openai  # Options: openai, google
TEXT_PROVIDER=openai       # Options: openai, anthropic, openrouter, google

# Model names
TEXT_EMBEDDING_MODEL=text-embedding-3-small  # Model name for embeddings
TEXT_MODEL=gpt-4o                           # Model name for text generation

# API Keys (based on chosen providers)
OPENAI_API_KEY=sk-...       # Required when using OpenAI
ANTHROPIC_API_KEY=sk-...    # Required when using Anthropic
OPENROUTER_API_KEY=sk-...   # Required when using OpenRouter
GOOGLE_API_KEY=...          # Required when using Google
```

### Optional Settings

```env
# Optional base URLs (for custom endpoints)
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
GOOGLE_BASE_URL=https://generativelanguage.googleapis.com/v1beta

# Token limits
MAX_INPUT_TOKENS=4000      # Maximum input tokens
MAX_OUTPUT_TOKENS=4096     # Maximum output tokens

# Contextual RAG settings
CTX_RAG_ENABLED=true       # Enable improved chunking with contextual RAG (uses TEXT_MODEL)
```

## Usage

The plugin automatically starts the RAG service when your agent initializes. The service provides the following capabilities:

1. **Knowledge Upload**: Add documents to the knowledge base
2. **Knowledge Retrieval**: Retrieve relevant information for queries

### Example: Adding Knowledge

```javascript
// Example of adding a PDF document to the knowledge base
const fileBuffer = fs.readFileSync('document.pdf');
const contentType = 'application/pdf';
const originalFilename = 'document.pdf';

// Get the RAG service from agent runtime
const ragService = runtime.getService('rag');

// Add the document to the knowledge base
await ragService.addKnowledge(
  'document-1', // Client document ID
  fileBuffer, // File content as Buffer
  contentType, // MIME type
  originalFilename, // Original filename
  worldId // World ID
);
```

### Contextual RAG

When `CTX_RAG_ENABLED=true`, the plugin uses your configured `TEXT_MODEL` to enhance document chunks with additional contextual information, improving the quality of embeddings and retrieval. This technique, inspired by Anthropic's Cookbook, produces better search results by ensuring each chunk has sufficient context for accurate understanding.

## Supported Models

### OpenAI

- Text Embedding: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
- Text Generation: gpt-4o, gpt-4-turbo, gpt-3.5-turbo, etc.

### Google

- Text Embedding: text-embedding-004, gemini-embedding-exp-03-07
- Text Generation: gemini-1.5-pro-latest, gemini-1.5-flash-latest, etc.

### Anthropic

- Text Generation: claude-3-opus-20240229, claude-3-sonnet-20240229, claude-3-haiku-20240307, etc.

### OpenRouter

- Text Generation: Various models from multiple providers

## Troubleshooting

If you encounter issues with the RAG plugin:

1. Ensure all required environment variables are set correctly
2. Check that your API keys are valid and have sufficient quota
3. Verify that the chosen models are supported by the respective providers

For more detailed logs, set `LOG_LEVEL=debug` in your environment.
