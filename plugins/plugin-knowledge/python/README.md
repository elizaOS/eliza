# elizaos-plugin-knowledge

Knowledge and RAG (Retrieval Augmented Generation) plugin for elizaOS.

This plugin provides document processing, embedding generation, and semantic search capabilities for elizaOS agents.

## Features

- **Document Processing**: Extract text from PDF, DOCX, Markdown, and plain text files
- **Text Chunking**: Split documents into semantic chunks with configurable overlap
- **Embedding Generation**: Generate embeddings using OpenAI, Google, or Anthropic providers
- **Semantic Search**: Find relevant knowledge based on query similarity
- **Contextual Retrieval**: Optionally enrich chunks with contextual information

## Installation

```bash
pip install elizaos-plugin-knowledge
```

### Optional Dependencies

```bash
# For OpenAI embedding support
pip install elizaos-plugin-knowledge[openai]

# For Anthropic support
pip install elizaos-plugin-knowledge[anthropic]

# For Google AI support
pip install elizaos-plugin-knowledge[google]

# For PDF processing
pip install elizaos-plugin-knowledge[pdf]

# For DOCX processing
pip install elizaos-plugin-knowledge[docx]

# Install all optional dependencies
pip install elizaos-plugin-knowledge[all]
```

## Usage

### Basic Usage

```python
from elizaos_plugin_knowledge import KnowledgeService, KnowledgeConfig

# Create configuration
config = KnowledgeConfig(
    embedding_provider="openai",
    embedding_model="text-embedding-3-small",
    embedding_dimension=1536,
)

# Initialize service
service = KnowledgeService(config)

# Add knowledge from text
await service.add_knowledge(
    content="The capital of France is Paris.",
    content_type="text/plain",
    filename="facts.txt",
)

# Search for knowledge
results = await service.search("What is the capital of France?")
for result in results:
    print(f"Score: {result.similarity:.2f} - {result.content}")
```

### With elizaOS Runtime

```python
from elizaos import Plugin
from elizaos_plugin_knowledge import create_knowledge_plugin

# Create the plugin
plugin = create_knowledge_plugin()

# Register with runtime
runtime.register_plugin(plugin)
```

## Configuration

| Parameter               | Type | Default                  | Description                              |
| ----------------------- | ---- | ------------------------ | ---------------------------------------- |
| `embedding_provider`    | str  | "openai"                 | Provider for embeddings (openai, google) |
| `embedding_model`       | str  | "text-embedding-3-small" | Model name for embeddings                |
| `embedding_dimension`   | int  | 1536                     | Embedding vector dimension               |
| `ctx_knowledge_enabled` | bool | False                    | Enable contextual enrichment             |
| `text_provider`         | str  | None                     | Provider for text generation             |
| `text_model`            | str  | None                     | Model for text generation                |
| `chunk_size`            | int  | 500                      | Target tokens per chunk                  |
| `chunk_overlap`         | int  | 100                      | Overlap tokens between chunks            |

## API Reference

### KnowledgeService

The main service class for knowledge management.

#### Methods

- `add_knowledge(content, content_type, filename, metadata)` - Add a document to the knowledge base
- `search(query, count, threshold)` - Search for relevant knowledge
- `get_knowledge(message)` - Get knowledge relevant to a message
- `delete_knowledge(knowledge_id)` - Delete a knowledge item

### KnowledgeProvider

Provider that supplies knowledge context to agent prompts.

## License

MIT License - see LICENSE file for details.



