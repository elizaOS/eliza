---
sidebar_position: 4
title: Knowledge System
description: Complete guide to setting up and using the ElizaOS Knowledge Plugin for document processing and RAG
keywords:
  [knowledge, RAG, embeddings, documents, processing, retrieval, semantic search, plugin-knowledge]
image: /img/knowledge.jpg
---

# 🧠 Knowledge System

The Knowledge System in ElizaOS enables agents to process, store, and retrieve information from documents using the **@elizaos/plugin-knowledge** plugin. This provides Retrieval-Augmented Generation (RAG) capabilities, allowing agents to answer questions based on stored knowledge.

## Quick Start

### Step 1: Install the Plugin

Add the knowledge plugin to your agent configuration by including it in the plugins array as a string:

```typescript
import { type Character } from '@elizaos/core';

export const character: Character = {
  name: 'MyAgent',
  plugins: [
    '@elizaos/plugin-sql', // MUST be first - provides database
    '@elizaos/plugin-openai', // MUST be before knowledge - provides embeddings
    '@elizaos/plugin-knowledge', // Requires both sql and embedding provider
    // ... other plugins can go here
  ],
  // ... rest of character config
};
```

> ⚠️ **CRITICAL: Plugin Order Matters!**
>
> The knowledge plugin has dependencies that MUST be loaded in the correct order:
>
> 1. **`@elizaos/plugin-sql`** - Must be loaded FIRST as it provides the database adapter
> 2. **An embedding provider plugin** (e.g., `@elizaos/plugin-openai`) - Must be loaded BEFORE knowledge plugin as it provides the text embedding service
> 3. **`@elizaos/plugin-knowledge`** - Must be loaded AFTER its dependencies
>
> If you don't follow this order, the knowledge plugin will fail to initialize!

### Step 2: Enable Auto-Loading (Recommended)

Add this to your `.env` file to automatically load documents on startup:

```env
LOAD_DOCS_ON_STARTUP=true
```

### Step 3: Create Knowledge Folder

Create a `knowledge` folder in your project root and add your documents:

```
your-project/
├── .env
├── knowledge/          <-- Create this folder
│   ├── guide.pdf
│   ├── documentation.md
│   ├── data.txt
│   └── ... more documents
├── src/
└── package.json
```

That's it! Your agent will automatically load all documents when it starts.

### Complete Example

Here's a full example of a character configuration with the knowledge plugin:

```typescript
import { type Character } from '@elizaos/core';

export const character: Character = {
  name: 'KnowledgeBot',
  plugins: [
    // Required dependencies in correct order
    '@elizaos/plugin-sql', // 1. Database (REQUIRED FIRST)
    '@elizaos/plugin-openai', // 2. Embeddings provider (REQUIRED SECOND)
    '@elizaos/plugin-knowledge', // 3. Knowledge plugin (MUST BE AFTER DEPENDENCIES)
    '@elizaos/plugin-bootstrap',

    // Optional plugins can go after
    ...(process.env.DISCORD_API_TOKEN ? ['@elizaos/plugin-discord'] : []),
    ...(process.env.TELEGRAM_BOT_TOKEN ? ['@elizaos/plugin-telegram'] : []),
  ],
  system:
    'You are a helpful assistant that uses your knowledge base to answer questions accurately.',
  bio: [
    'Expert at retrieving and using stored knowledge',
    'Provides accurate information from documents',
    'Helpful and conversational',
  ],
  // ... other character properties
};
```

**Alternative Embedding Providers:**

If you're not using OpenAI, you can use other embedding providers, but they must still be loaded before the knowledge plugin:

```typescript
plugins: [
  '@elizaos/plugin-sql', // Always first
  '@elizaos/plugin-openai',
  // OR '@elizaos/plugin-google',  // OR use Google for embeddings
  // OR '@elizaos/plugin-local-ai', // OR use local embeddings
  '@elizaos/plugin-knowledge', // Always after sql and embedding provider
];
```

## How It Works

When you start your agent with the knowledge plugin:

1. **Automatic Detection**: The plugin checks if you have plugin-openai configured
2. **Document Loading**: If `LOAD_DOCS_ON_STARTUP=true`, it scans the knowledge folder
3. **Processing**: Each document is processed, chunked, and embedded
4. **Storage**: Knowledge is stored in the agent's database with vector embeddings
5. **Retrieval**: When users ask questions, relevant knowledge is retrieved and used

## Folder Structure

The plugin looks for documents in this order:

1. **Custom Path** (if `KNOWLEDGE_PATH` env var is set)
2. **`knowledge/` folder** in project root (recommended)
3. **`docs/` folder** in project root (legacy support)

```
your-project/
├── knowledge/              # Primary location (recommended)
│   ├── products/          # You can organize in subfolders
│   │   ├── manual.pdf
│   │   └── specs.md
│   ├── policies/
│   │   ├── terms.txt
│   │   └── privacy.md
│   └── general-info.pdf
└── docs/                  # Alternative location (legacy)
```

## Supported File Types

### Documents

- **PDF** (`.pdf`) - Full text extraction
- **Markdown** (`.md`, `.markdown`) - Preserves formatting
- **Text** (`.txt`, `.log`) - Plain text files
- **Microsoft Word** (`.doc`, `.docx`) - Full document support

### Code Files

- **JavaScript/TypeScript** (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`)
- **Python** (`.py`, `.pyw`, `.pyi`)
- **Java/Kotlin** (`.java`, `.kt`, `.kts`)
- **C/C++/C#** (`.c`, `.cpp`, `.cc`, `.h`, `.hpp`, `.cs`)
- **Go** (`.go`)
- **Rust** (`.rs`)
- **Ruby** (`.rb`)
- **PHP** (`.php`)
- **Swift** (`.swift`)
- And many more programming languages...

### Data & Config Files

- **JSON** (`.json`)
- **YAML** (`.yaml`, `.yml`)
- **XML** (`.xml`)
- **CSV** (`.csv`)
- **TOML** (`.toml`)
- **INI** (`.ini`, `.cfg`, `.conf`)
- **Environment** (`.env`)

### Web Files

- **HTML** (`.html`, `.htm`)
- **CSS** (`.css`, `.scss`, `.sass`, `.less`)
- **Vue/React/Svelte** (`.vue`, `.jsx`, `.svelte`)

## Using Knowledge

Once documents are loaded, users can interact naturally:

### Asking Questions

Users can ask questions in natural language:

- "What does the documentation say about authentication?"
- "Can you explain the setup process from the guide?"
- "What are the product specifications?"
- "Search your knowledge for information about pricing"

### Available Actions

The plugin provides two main actions:

#### 1. PROCESS_KNOWLEDGE

Adds new documents or text to the knowledge base:

```
User: "Process the document at /path/to/new-guide.pdf"
Agent: "I'll process the document and add it to my knowledge base."

User: "Remember this: Our office hours are 9 AM to 5 PM EST"
Agent: "I've added that information to my knowledge base."
```

#### 2. SEARCH_KNOWLEDGE

Explicitly searches the knowledge base:

```
User: "Search your knowledge for refund policy"
Agent: "Here's what I found about refund policy: [relevant information]"
```

## Configuration Options

### Basic Configuration

For most users, the default configuration works perfectly. Just add the plugin and optionally set:

```env
# Enable automatic document loading
LOAD_DOCS_ON_STARTUP=true

# Optional: Custom document path
KNOWLEDGE_PATH=/path/to/your/documents
```

### Advanced Configuration

If you're not using plugin-openai, you'll need to configure embeddings:

```env
# Embedding Provider Configuration
EMBEDDING_PROVIDER=openai          # or google
TEXT_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=your-api-key       # or GOOGLE_API_KEY for Google

# Embedding Dimensions (must match your model)
# OpenAI text-embedding-3-small: 1536
# OpenAI text-embedding-3-large: 3072
# Google text-embedding-004: 768
```

### Rate Limiting

Configure rate limits to avoid API throttling:

```env
MAX_CONCURRENT_REQUESTS=30
REQUESTS_PER_MINUTE=60
TOKENS_PER_MINUTE=150000
```

## Web Interface

The plugin includes a web interface for managing documents. Access it at:

```
http://localhost:3000/api/agents/[your-agent-id]/plugins/knowledge/display
```

Features:

- Upload new documents
- View processed documents
- Delete documents
- Search knowledge base
- View processing statistics

## Best Practices

### 1. Document Organization

**Structure your knowledge folder logically:**

```
knowledge/
├── products/           # Product information
├── support/           # Support documentation
├── policies/          # Company policies
└── faqs/             # Frequently asked questions
```

**Benefits:**

- Easier maintenance
- Better context for the agent
- Simpler updates

### 2. Document Preparation

**For best results:**

- Use clear, descriptive filenames
- Break large documents into focused topics
- Use markdown for structured content
- Include context in document headers

**Example markdown structure:**

```markdown
# Product Setup Guide

Category: Installation
Last Updated: 2024-01-15

## Overview

This guide covers the installation process...

## Prerequisites

- Requirement 1
- Requirement 2

## Steps

1. First step...
2. Second step...
```

### 3. Content Guidelines

**DO:**

- ✅ Use clear, concise language
- ✅ Structure information hierarchically
- ✅ Include examples and use cases
- ✅ Update documents regularly

**DON'T:**

- ❌ Include sensitive information (passwords, keys)
- ❌ Use overly technical jargon without explanation
- ❌ Create documents larger than 10MB
- ❌ Mix unrelated topics in one document

### 4. Performance Optimization

**For large knowledge bases:**

- Keep individual files under 5MB
- Use focused, topic-specific documents
- Regularly review and update content
- Remove outdated information

## Troubleshooting

### Plugin Initialization Errors

**If you see errors like "Knowledge service not available" or "Failed to initialize Knowledge plugin":**

1. **Check plugin order** - This is the #1 cause of initialization failures!

   ```typescript
   // ❌ WRONG - knowledge plugin before its dependencies
   plugins: ['@elizaos/plugin-knowledge', '@elizaos/plugin-sql', '@elizaos/plugin-openai'];

   // ✅ CORRECT - dependencies first
   plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-openai', '@elizaos/plugin-knowledge'];
   ```

2. **Verify embedding provider** - You MUST have an embedding provider:

   - `@elizaos/plugin-openai` (requires `OPENAI_API_KEY`)
   - `@elizaos/plugin-google` (requires `GOOGLE_API_KEY`)
   - `@elizaos/plugin-local-ai` (for local models)

3. **Check environment variables** - Ensure your embedding provider has valid credentials

### Documents Not Loading

**Check these common issues:**

1. **Folder exists?**

   ```bash
   ls -la knowledge/  # Should show your documents
   ```

2. **Environment variable set?**

   ```bash
   grep LOAD_DOCS_ON_STARTUP .env  # Should show =true
   ```

3. **File permissions?**

   ```bash
   # Ensure files are readable
   chmod -R 644 knowledge/*.pdf
   ```

4. **Supported file type?**
   - Check the supported file types list above
   - Ensure files aren't corrupted

### Knowledge Not Retrieved

**If the agent can't find information:**

1. **Check if documents were processed:**

   - Look for startup logs: "Loaded X documents from docs folder"
   - Access the web interface to verify documents

2. **Improve your questions:**

   - Be specific: "What does the setup guide say about database configuration?"
   - Use keywords from the documents
   - Try different phrasings

3. **Verify content:**
   - Ensure the information exists in your documents
   - Check if documents are properly formatted
   - Avoid documents with only images (no text)

### Processing Errors

**For specific file issues:**

1. **PDF errors:**

   - Ensure PDFs aren't password-protected
   - Check if PDFs contain extractable text
   - Try re-saving the PDF

2. **Large file issues:**

   - Split documents over 10MB
   - Use text formats when possible
   - Compress images in documents

3. **Encoding issues:**
   - Save files as UTF-8
   - Avoid special characters in filenames
   - Use standard file extensions

## API Reference

### REST API Endpoints

The plugin provides these HTTP endpoints:

```
# Upload a document
POST /api/agents/{agentId}/plugins/knowledge/documents
Content-Type: multipart/form-data
Body: file upload

# List all documents
GET /api/agents/{agentId}/plugins/knowledge/documents

# Get specific document
GET /api/agents/{agentId}/plugins/knowledge/documents/{documentId}

# Delete a document
DELETE /api/agents/{agentId}/plugins/knowledge/documents/{documentId}

# Search knowledge
POST /api/agents/{agentId}/plugins/knowledge/search
Body: { "query": "search terms" }
```

### Programmatic Usage

For advanced users who want to add knowledge programmatically:

```typescript
// Get the knowledge service
const knowledgeService = runtime.getService('knowledge');

// Add knowledge from text
await knowledgeService.addKnowledge({
  clientDocumentId: 'unique-id',
  content: 'The information to store...',
  contentType: 'text/plain',
  originalFilename: 'dynamic-content.txt',
  worldId: runtime.agentId,
  roomId: message.roomId,
  entityId: message.entityId,
});

// Search knowledge
const results = await knowledgeService.getKnowledge(message);
```

## Migration from Legacy System

If you're migrating from the old knowledge system:

1. **Move files to knowledge folder:**

   ```bash
   mkdir knowledge
   mv docs/* knowledge/
   ```

2. **Update configuration:**

   - Remove old knowledge arrays from character files
   - Add the plugin to your agent
   - Set `LOAD_DOCS_ON_STARTUP=true`

3. **Clean up:**
   - Remove manual knowledge loading code
   - Delete old knowledge management functions
   - Update any custom integrations

## Security Considerations

### Data Privacy

- **Never store sensitive data** like passwords, API keys, or personal information
- **Review documents** before adding them to ensure compliance
- **Use access controls** in production environments

### File Security

- **Validate file sources** before processing
- **Scan for malware** in production systems
- **Limit file sizes** to prevent resource exhaustion
- **Monitor disk usage** for knowledge storage

### API Security

- **Authenticate API requests** in production
- **Rate limit** upload endpoints
- **Validate file types** on upload
- **Log access** to knowledge endpoints

## Performance Tips

### Optimizing Retrieval

1. **Quality over Quantity**: Focus on high-quality, relevant documents
2. **Regular Maintenance**: Remove outdated or redundant information
3. **Structured Content**: Use consistent formatting across documents
4. **Metadata**: Include descriptive headers and categories

### Scaling Considerations

For large deployments:

- Use PostgreSQL instead of PGLite for better performance
- Implement caching for frequently accessed knowledge
- Consider dedicated embedding services
- Monitor query performance and optimize as needed

## Examples

### Customer Support Bot

```
knowledge/
├── products/
│   ├── product-catalog.md
│   ├── pricing-guide.pdf
│   └── feature-comparison.xlsx
├── support/
│   ├── troubleshooting-guide.md
│   ├── faq.md
│   └── contact-info.txt
└── policies/
    ├── return-policy.pdf
    ├── warranty-terms.md
    └── privacy-policy.txt
```

### Technical Documentation Bot

```
knowledge/
├── api/
│   ├── rest-api-reference.md
│   ├── graphql-schema.json
│   └── examples/
│       ├── python-examples.py
│       └── javascript-examples.js
├── guides/
│   ├── getting-started.md
│   ├── advanced-usage.md
│   └── best-practices.md
└── troubleshooting/
    ├── common-errors.md
    └── debugging-guide.md
```

### Company Information Bot

```
knowledge/
├── about/
│   ├── company-history.md
│   ├── mission-vision.txt
│   └── team-bios.md
├── services/
│   ├── service-offerings.pdf
│   ├── case-studies/
│   └── testimonials.md
└── resources/
    ├── blog-posts/
    ├── whitepapers/
    └── presentations/
```

## Further Reading

- [Plugin System](./plugins.md) - Learn about ElizaOS plugins
- [Database System](./database.md) - Understand knowledge storage
- [Agent Configuration](./agents.md) - Configure your agents

---

**Need Help?** Check the [plugin README](https://github.com/elizaos/eliza/tree/main/packages/plugin-knowledge) for additional details and advanced configuration options.
