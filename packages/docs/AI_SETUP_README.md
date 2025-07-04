# 🤖 ElizaOS Documentation AI Setup

Quick guide to enable AI-powered features in the ElizaOS documentation.

## ⚡ Quick Start

### 1. Add API Key

```bash
cd packages/docs
cp .env.example .env
# Edit .env and add your API key
```

### 2. Start Documentation

```bash
# From root directory
bun start:docs

# From packages/docs
bun start
```

Documentation available at: http://localhost:3002

## 🔍 Search Features

### With AI Enabled

- **Semantic Search**: Understands context and meaning
- **Smart Suggestions**: AI-powered query refinements
- **Enhanced Results**: Better ranking and relevance
- **Natural Language**: Search with questions like "how do I create an agent?"

### Without AI (Default)

- **Fast Local Search**: Instant results using Lunr.js
- **Keyword Matching**: Traditional text-based search
- **Search History**: Recent searches and suggestions
- **No External Calls**: Everything runs in your browser

## 🔑 Supported AI Providers

| Provider      | Cost               | Speed     | Setup                                               |
| ------------- | ------------------ | --------- | --------------------------------------------------- |
| **OpenAI**    | ~$0.01/1k searches | Fast      | [Get API Key](https://platform.openai.com/api-keys) |
| **Groq**      | Free tier          | Very Fast | [Get API Key](https://console.groq.com/keys)        |
| **Anthropic** | ~$0.01/1k searches | Fast      | [Get API Key](https://console.anthropic.com/keys)   |
| **Ollama**    | Free (local)       | Medium    | [Install Ollama](https://ollama.ai)                 |

## ⚙️ Configuration

### Disable AI Features

```bash
# Use regular search only
REACT_APP_AI_ENABLED=false
```

### Enable AI Search (OpenAI)

```bash
REACT_APP_AI_ENABLED=true
REACT_APP_OPENAI_API_KEY=sk-your-key-here
```

### Enable AI Search (Anthropic)

```bash
REACT_APP_AI_ENABLED=true
REACT_APP_ANTHROPIC_API_KEY=your-key-here
```

### Enable AI Search (Groq)

```bash
REACT_APP_AI_ENABLED=true
REACT_APP_GROQ_API_KEY=your-key-here
```

### Enable AI Search (Ollama - Local)

```bash
REACT_APP_AI_ENABLED=true
REACT_APP_OLLAMA_BASE_URL=http://localhost:11434
```

### All Features Configuration

```bash
# Enable/Disable AI
REACT_APP_AI_ENABLED=true

# AI Provider (choose one)
REACT_APP_OPENAI_API_KEY=sk-your-key-here
# OR
REACT_APP_ANTHROPIC_API_KEY=your-key-here
# OR
REACT_APP_GROQ_API_KEY=your-key-here
# OR
REACT_APP_OLLAMA_BASE_URL=http://localhost:11434

# Additional Features
AI_ASSISTANT_ENABLED=true
AI_SEARCH_ENABLED=true
AI_RECOMMENDATIONS_ENABLED=true

# Performance
AI_CACHE_ENABLED=true
REACT_APP_DEFAULT_AI_MODEL=gpt-4o-mini
```

## ✨ How It Works

1. **Regular Search (Default)**

   - Works immediately without configuration
   - Searches through pre-built index
   - No API calls or external dependencies
   - Perfect for offline use

2. **AI-Enhanced Search**
   - Activates when API key is configured
   - Enhances regular search results
   - Provides intelligent suggestions
   - Shows AI indicator (✨) in search bar

## 🛠️ Commands Reference

```bash
# Documentation Commands
bun start:docs          # Start docs server
bun dev:docs            # Development mode
bun build:docs          # Build for production

# Testing
bun test:links          # Verify all links
bun test:performance    # Performance testing
bun test:accessibility  # Accessibility testing
```

## 🔒 Security & Privacy

- ✅ API keys stored locally only
- ✅ Never commit `.env` files
- ✅ Search works without AI
- ✅ No tracking when AI disabled
- ✅ All AI calls are optional

## 📚 Full Documentation

For complete setup and configuration details, see:

- [AI Configuration Guide](/docs/getting-started/ai-configuration)
- [Environment Variables Reference](/docs/simple/guides/cli-setup#environment-configuration)

---

**Need help?** Check the [troubleshooting section](./docs/getting-started/ai-configuration.md#troubleshooting) or ask in [Discord](https://discord.gg/elizaos).
