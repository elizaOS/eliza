# Knowledge Plugin for ElizaOS

Give your AI agent the ability to learn from documents and answer questions based on that knowledge. Works out of the box with zero configuration!

## 📦 Installation Modes

The Knowledge plugin supports multiple deployment modes to fit your use case:

### **Full Mode** (Default - With UI & Routes)

Perfect for standard deployments with the full web interface:

```typescript
import { knowledgePlugin } from '@elizaos/plugin-knowledge';
// or
import knowledgePlugin from '@elizaos/plugin-knowledge';

export const character = {
  plugins: [knowledgePlugin],
};
```

### **Headless Mode** (Service + Provider + Actions, No UI)

For server deployments without frontend:

```typescript
import { knowledgePluginHeadless } from '@elizaos/plugin-knowledge';

export const character = {
  plugins: [knowledgePluginHeadless],
};
```

### **Core Mode** (Service + Provider Only)

For cloud runtimes or minimal deployments (no routes, no UI, no actions):

```typescript
import { knowledgePluginCore } from '@elizaos/plugin-knowledge';

export const character = {
  plugins: [knowledgePluginCore],
};
```

### **Custom Configuration**

Create your own configuration:

```typescript
import { createKnowledgePlugin } from '@elizaos/plugin-knowledge';

const customPlugin = createKnowledgePlugin({
  enableUI: false, // Disable frontend UI
  enableRoutes: false, // Disable HTTP routes
  enableActions: true, // Keep actions enabled
  enableTests: false, // Disable tests
});

export const character = {
  plugins: [customPlugin],
};
```

## 🚀 Getting Started (Beginner-Friendly)

### Step 1: Add the Plugin

The Knowledge plugin works automatically with any ElizaOS agent. Just add it to your agent's plugin list:

```typescript
// In your character file (e.g., character.ts)
export const character = {
  name: 'MyAgent',
  plugins: [
    '@elizaos/plugin-openai', // ← Make sure you have this
    '@elizaos/plugin-knowledge', // ← Add this line (full mode)
    // ... your other plugins
  ],
  // ... rest of your character config
};
```

**That's it!** Your agent can now learn from documents. No environment variables or API keys needed.

### Step 2: Upload Documents (Optional)

Want your agent to automatically learn from documents when it starts?

1. **Create a `docs` folder** in your project root:

   ```
   your-project/
   ├── .env
   ├── docs/           ← Create this folder
   │   ├── guide.pdf
   │   ├── manual.txt
   │   └── notes.md
   └── package.json
   ```

2. **Add this line to your `.env` file:**

   ```env
   LOAD_DOCS_ON_STARTUP=true
   ```

3. **Start your agent** - it will automatically learn from all documents in the `docs` folder!

### Step 3: Ask Questions

Once documents are loaded, just talk to your agent naturally:

- "What does the guide say about setup?"
- "Search your knowledge for configuration info"
- "What do you know about [any topic]?"

Your agent will search through all loaded documents and give you relevant answers!

## 📁 Supported File Types

The plugin can read almost any document:

- **Text Files:** `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.yaml`
- **Documents:** `.pdf`, `.doc`, `.docx`
- **Code Files:** `.js`, `.ts`, `.py`, `.java`, `.cpp`, `.html`, `.css` and many more

## 💬 Using the Web Interface

The plugin includes a web interface for managing documents!

Click the Knowledge tab in the right panel.

You can upload, view, and delete documents directly from your browser.

## 🎯 Agent Actions

Your agent automatically gets these new abilities:

- **PROCESS_KNOWLEDGE** - "Remember this document: [file path or text]"
- **SEARCH_KNOWLEDGE** - "Search your knowledge for [topic]"

## ❓ FAQ

**Q: Do I need any API keys?**  
A: No! It uses your existing OpenAI/Google/Anthropic setup automatically.

**Q: What if I don't have any AI plugins?**  
A: You need at least one AI provider plugin (like `@elizaos/plugin-openai`) for embeddings.

**Q: Can I upload documents while the agent is running?**  
A: Yes! Use the web interface or just tell your agent to process a file.

**Q: How much does this cost?**  
A: Only the cost of generating embeddings (usually pennies per document).

---

## 🔧 Advanced Configuration (Developers)

> **⚠️ Note for Beginners:** The settings below are for advanced users only. The plugin works great without any of this configuration!

<details>
<summary><strong>🚀 Enhanced Contextual Knowledge (Recommended for Developers)</strong></summary>

For significantly better understanding of complex documents, enable contextual embeddings with caching:

```env
# Enable enhanced contextual understanding
CTX_KNOWLEDGE_ENABLED=true

# Use OpenRouter with Claude for best results + 90% cost savings via caching
TEXT_PROVIDER=openrouter
TEXT_MODEL=anthropic/claude-3.5-sonnet
OPENROUTER_API_KEY=your-openrouter-api-key
```

**Benefits:**

- 📈 **Better Understanding:** Chunks include surrounding context
- 💰 **90% Cost Reduction:** Document caching reduces repeated processing costs
- 🎯 **Improved Accuracy:** More relevant search results

**Best Models for Contextual Mode:**

- `anthropic/claude-3.5-sonnet` (recommended)
- `google/gemini-2.5-flash` (fast + cheap)
- `anthropic/claude-3.5-haiku` (budget option)

</details>

<details>
<summary><strong>⚙️ Custom Configuration Options</strong></summary>

### Document Loading

```env
LOAD_DOCS_ON_STARTUP=true          # Auto-load from docs folder
KNOWLEDGE_PATH=/custom/path        # Custom document path (default: ./docs)
```

### Embedding Configuration

```env
# Only needed if you're not using a standard AI plugin
EMBEDDING_PROVIDER=openai          # openai | google
TEXT_EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536           # Vector dimension
```

### Text Generation (for Contextual Mode)

```env
TEXT_PROVIDER=openrouter           # openai | anthropic | openrouter | google
TEXT_MODEL=anthropic/claude-3.5-sonnet
```

### API Keys (as needed)

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
GOOGLE_API_KEY=your-key
```

### Performance Tuning

```env
MAX_CONCURRENT_REQUESTS=30         # Parallel processing limit
REQUESTS_PER_MINUTE=60             # Rate limiting
TOKENS_PER_MINUTE=150000           # Token rate limiting
MAX_INPUT_TOKENS=4000              # Chunk size limit
MAX_OUTPUT_TOKENS=4096             # Response size limit
```

</details>

<details>
<summary><strong>🔌 API Reference</strong></summary>

### HTTP Endpoints

- `POST /api/agents/{agentId}/plugins/knowledge/documents` - Upload documents
- `GET /api/agents/{agentId}/plugins/knowledge/documents` - List all documents
- `GET /api/agents/{agentId}/plugins/knowledge/documents/{id}` - Get specific document
- `DELETE /api/agents/{agentId}/plugins/knowledge/documents/{id}` - Delete document
- `GET /api/agents/{agentId}/plugins/knowledge/display` - Web interface

### Programmatic Usage

```typescript
import { KnowledgeService } from '@elizaos/plugin-knowledge';

// Get the service from runtime
const knowledgeService = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);

// Add knowledge programmatically
const result = await knowledgeService.addKnowledge({
  agentId: runtime.agentId,
  clientDocumentId: '' as UUID, // Auto-generated based on content
  content: documentContent, // Base64 for PDFs, plain text for others
  contentType: 'application/pdf',
  originalFilename: 'document.pdf',
  worldId: runtime.agentId,
  roomId: runtime.agentId,
  entityId: runtime.agentId,
  metadata: {
    // Optional custom metadata
    source: 'upload',
    author: 'John Doe',
  },
});

// The provider automatically retrieves relevant knowledge during conversations
// But you can also search directly:
const knowledgeItems = await knowledgeService.getKnowledge(
  message, // The message/query
  {
    roomId: runtime.agentId,
    worldId: runtime.agentId,
    entityId: runtime.agentId,
  }
);
```

### Cloud/Custom Runtime Usage

For cloud deployments or custom runtimes, use the core mode and access the service directly:

```typescript
import { knowledgePluginCore, KnowledgeService } from '@elizaos/plugin-knowledge';

// In your cloud runtime setup
const runtime = await createRuntime({
  // ... your runtime config
  plugins: [knowledgePluginCore], // Core mode: no routes, no UI
});

// Access the service
const knowledgeService = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);

// Add documents
await knowledgeService.addKnowledge({
  agentId: runtime.agentId,
  clientDocumentId: '' as UUID,
  content: base64Content,
  contentType: 'application/pdf',
  originalFilename: 'company-docs.pdf',
  worldId: runtime.agentId,
  roomId: runtime.agentId,
  entityId: runtime.agentId,
});

// The knowledge provider will automatically inject relevant context
// into the agent's conversations based on the query
```

</details>

<details>
<summary><strong>🐛 Troubleshooting</strong></summary>

### Common Issues

**"Knowledge plugin failed to initialize"**

- Make sure you have an AI provider plugin (openai, google-genai, etc.)
- Check that your AI provider has valid API keys

**"Documents not loading automatically"**

- Verify `LOAD_DOCS_ON_STARTUP=true` in your `.env` file
- Check that the `docs` folder exists in your project root
- Make sure files are readable and in supported formats

**"Search returns no results"**

- Documents need to be processed first (wait for startup to complete)
- Try simpler search terms
- Check that documents actually contain the content you're searching for

**"Out of memory errors"**

- Reduce `MAX_CONCURRENT_REQUESTS` to 10-15
- Process smaller documents or fewer documents at once
- Increase Node.js memory limit: `node --max-old-space-size=4096`

### Performance Tips

- **Smaller chunks = better search precision** (but more tokens used)
- **Contextual mode = better understanding** (but slower processing)
- **Batch document uploads** rather than one-by-one for better performance

</details>

## 📝 License

MIT License - See the main ElizaOS license for details.
