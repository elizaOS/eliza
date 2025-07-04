# AI Documentation Assistant Configuration

Configure AI-powered features in the ElizaOS documentation for enhanced search, recommendations, and interactive assistance.

## 🤖 Setting Up AI Features

### Step 1: Create Environment File

Navigate to the docs directory and create your environment configuration:

```bash
cd packages/docs
cp .env.example .env
```

### Step 2: Add Your AI API Key

Edit the `.env` file and add your preferred AI provider's API key:

```bash
# Choose one AI provider:

# Option 1: OpenAI (Recommended)
OPENAI_API_KEY=sk-your-openai-api-key-here

# Option 2: Anthropic Claude
ANTHROPIC_API_KEY=your-anthropic-api-key-here

# Option 3: Groq (Fast & Free)
GROQ_API_KEY=your-groq-api-key-here

# Option 4: Local Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1
```

### Step 3: Enable AI Features

Configure which AI features you want to use:

```bash
# AI Feature Toggles
AI_ASSISTANT_ENABLED=true       # Floating AI assistant
AI_SEARCH_ENABLED=true          # Enhanced search with AI
AI_RECOMMENDATIONS_ENABLED=true # Smart content suggestions
```

## 🔑 Getting API Keys

### OpenAI (Recommended)

1. Visit [platform.openai.com](https://platform.openai.com/api-keys)
2. Create new API key
3. Copy and paste into `.env` file
4. **Cost**: ~$0.01 per 1000 searches

### Anthropic Claude

1. Visit [console.anthropic.com](https://console.anthropic.com/keys)
2. Create API key
3. Add to `.env` file
4. **Cost**: Similar to OpenAI

### Groq (Free Tier Available)

1. Visit [console.groq.com](https://console.groq.com/keys)
2. Sign up for free account
3. Create API key
4. **Cost**: Free tier with rate limits

### Local Ollama (Free)

1. Install [Ollama](https://ollama.ai)
2. Run `ollama pull llama3.1`
3. Configure `OLLAMA_BASE_URL` in `.env`
4. **Cost**: Free (uses your hardware)

## ⚙️ Configuration Options

### Model Settings

```bash
# Model Configuration
DEFAULT_AI_MODEL=gpt-4o-mini    # Fastest and cheapest OpenAI model
AI_TEMPERATURE=0.3              # Lower = more focused responses
AI_MAX_TOKENS=1000              # Response length limit
```

### Performance Settings

```bash
# Performance Optimization
AI_RESPONSE_TIMEOUT=10000       # 10 second timeout
AI_CACHE_ENABLED=true           # Cache responses for speed
AI_CACHE_TTL=3600              # Cache for 1 hour
```

### Analytics (Optional)

```bash
# Usage Analytics
ANALYTICS_ENABLED=false         # Enable usage tracking
GOOGLE_ANALYTICS_ID=           # Your GA4 measurement ID
POSTHOG_API_KEY=               # PostHog analytics key
```

## 🚀 Starting the Documentation with AI

Once configured, start the documentation server:

```bash
# From the root directory
bun start:docs

# Or from packages/docs
bun start
```

The documentation will be available at `http://localhost:3002` with AI features enabled.

## ✨ AI Features Available

### 🤖 Floating AI Assistant

- **Context-aware help** based on current page
- **Code examples** with copy functionality
- **Cross-references** to related documentation
- **Real-time suggestions** as you browse

### 🔍 Enhanced Search

- **Semantic search** that understands intent
- **Code search** with syntax highlighting
- **Smart filtering** by content type
- **Instant suggestions** as you type

### 💡 Content Recommendations

- **Next steps** based on your current page
- **Related articles** using AI understanding
- **Learning path** suggestions for your skill level
- **Popular content** tailored to your interests

## 🛠️ Troubleshooting

### AI Assistant Not Working

1. **Check API key**: Ensure it's correctly set in `.env`
2. **Verify balance**: Make sure your API account has credits
3. **Check logs**: Look for error messages in browser console
4. **Test connectivity**: Try a simple API call manually

### Search Not Enhanced

1. **Restart server**: AI features require server restart after config changes
2. **Clear cache**: Delete browser cache and restart
3. **Check feature flags**: Ensure `AI_SEARCH_ENABLED=true`

### Slow Performance

1. **Increase timeout**: Set `AI_RESPONSE_TIMEOUT=15000`
2. **Enable caching**: Set `AI_CACHE_ENABLED=true`
3. **Use faster model**: Try `gpt-4o-mini` or Groq
4. **Check internet**: Ensure stable connection to AI provider

## 💰 Cost Management

### Estimated Costs (Monthly)

- **Light usage** (100 searches): ~$1-2
- **Moderate usage** (500 searches): ~$5-10
- **Heavy usage** (2000 searches): ~$20-40

### Cost Optimization

- Use `gpt-4o-mini` for lower costs
- Enable caching to reduce API calls
- Set reasonable rate limits
- Consider Groq's free tier for development

## 🔒 Security Best Practices

### Environment Variables

- **Never commit** `.env` files to version control
- **Use different keys** for development and production
- **Rotate keys** regularly
- **Monitor usage** for unexpected activity

### API Key Protection

```bash
# Good: Secure environment variable
OPENAI_API_KEY=sk-proj-...

# Bad: Hardcoded in code
const apiKey = "sk-proj-..."  // Never do this!
```

## 📊 Monitoring Usage

### Built-in Analytics

The documentation includes built-in usage tracking:

- **Search queries** and success rates
- **AI assistant** interaction patterns
- **Performance metrics** and response times
- **Cost tracking** and usage optimization

### Custom Analytics

Enable Google Analytics or PostHog for additional insights:

```bash
ANALYTICS_ENABLED=true
GOOGLE_ANALYTICS_ID=G-XXXXXXXXXX
```

---

## 🎯 Quick Setup Summary

1. **Copy environment file**: `cp .env.example .env`
2. **Add API key**: Edit `.env` with your preferred provider
3. **Start documentation**: `bun start:docs`
4. **Test AI features**: Try the search and assistant

The AI-enhanced documentation will significantly improve the user experience with intelligent search, contextual help, and personalized content recommendations.

---

**💡 Pro Tip**: Start with Groq's free tier for development, then upgrade to OpenAI's `gpt-4o-mini` for production use. This gives you the best balance of cost and performance.
