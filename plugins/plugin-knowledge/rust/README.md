# elizaos-plugin-knowledge (Rust)

This is the Rust implementation of the Knowledge plugin for elizaOS.

It provides Retrieval Augmented Generation (RAG) capabilities, including:

- Document processing and chunking
- Embedding generation via multiple providers
- Semantic search and knowledge retrieval
- Contextual enrichment of text chunks using LLMs

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-knowledge = "1.6.1"
```

## Usage

```rust
use elizaos_plugin_knowledge::{KnowledgePlugin, KnowledgeConfig, AddKnowledgeOptions};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Create config with defaults
    let config = KnowledgeConfig::default();

    // Create plugin
    let plugin = KnowledgePlugin::new(config);

    // Add knowledge
    let options = AddKnowledgeOptions {
        content: "This is some knowledge content...".to_string(),
        content_type: "text/plain".to_string(),
        filename: "doc.txt".to_string(),
        ..Default::default()
    };

    let result = plugin.add_knowledge(options).await?;
    println!("Added document: {:?}", result.document_id);

    // Search knowledge
    let results = plugin.search("search query", 5, 0.1).await?;
    for result in results {
        println!("Found: {} (similarity: {:.2})", result.content, result.similarity);
    }

    Ok(())
}
```

## Features

- **Document Processing**: Extract text from plain text, markdown, JSON
- **Smart Chunking**: Split documents into semantic chunks with configurable overlap
- **Embedding Generation**: Generate embeddings via OpenAI, Google, or custom providers
- **Semantic Search**: Find relevant knowledge using cosine similarity
- **Deterministic IDs**: Content-based document IDs for deduplication

## Development

```bash
# Build
cargo build

# Test
cargo test

# Build release
cargo build --release
```

## License

MIT License - see LICENSE file for details.



