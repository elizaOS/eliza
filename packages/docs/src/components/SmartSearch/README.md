# Smart Search Component

## Overview

The Smart Search component provides an AI-enhanced search experience for the ElizaOS documentation. It combines traditional Lunr.js search with optional AI-powered semantic search capabilities.

## Features

- **Traditional Search**: Uses Lunr.js for fast, client-side search
- **AI Enhancement**: Optional AI-powered semantic search (when configured)
- **Smart Suggestions**: Context-aware search suggestions
- **Keyboard Navigation**: Full keyboard support with arrow keys
- **Responsive Design**: Works on all device sizes
- **Filter Support**: Filter by documentation type (docs, API, packages, blog)

## Configuration

### AI Search Setup

For security reasons, AI API keys should NOT be exposed to the client. Instead:

1. **Development**: The component simulates AI features without real API calls
2. **Production**: Would require a server-side API endpoint to handle AI requests securely

### Environment Variables

The following environment variables control AI features:

```bash
# Enable/disable AI features (default: true)
REACT_APP_AI_ENABLED=true

# AI provider detection (component auto-detects based on which key is present)
REACT_APP_OPENAI_API_KEY=your-key      # For OpenAI
REACT_APP_ANTHROPIC_API_KEY=your-key   # For Anthropic
REACT_APP_GROQ_API_KEY=your-key        # For Groq
REACT_APP_OLLAMA_BASE_URL=http://localhost:11434  # For Ollama
```

**Important**: These environment variables are only used to detect which provider is configured. The actual API keys should NEVER be exposed to the client-side code.

## How It Works

1. **Regular Search**:

   - Uses Lunr.js index for fast text matching
   - Supports fuzzy search, wildcards, and phrase search
   - Categorizes results by type (docs, API, packages, blog)

2. **AI Enhancement** (when enabled):

   - Currently simulates AI features for demo purposes
   - In production, would call a secure server-side endpoint
   - Enhances results with semantic relevance scoring
   - Generates intelligent search suggestions

3. **Suggestions**:
   - Pattern-based suggestions (e.g., "agent" suggests agent-related topics)
   - Recent search history
   - Context-aware recommendations

## Security Considerations

- **Never expose API keys** in client-side code
- **Use server-side endpoints** for AI API calls
- **Implement rate limiting** on any AI endpoints
- **Validate and sanitize** all search queries

## Future Enhancements

1. **Server-side AI Integration**:

   - Create a secure API endpoint for AI search
   - Implement proper authentication and rate limiting
   - Cache AI responses for performance

2. **Enhanced Features**:
   - Voice search support
   - Search analytics
   - Personalized results based on user behavior
   - Multi-language support

## Usage

The component is automatically included in the Docusaurus theme and appears in the navbar. No additional setup is required for basic functionality.

```tsx
// The component is used internally by Docusaurus
// No manual integration needed
```

## Customization

To customize the search behavior, you can:

1. Modify search categories in the component
2. Adjust relevance scoring algorithms
3. Add custom suggestion patterns
4. Customize the UI styling via CSS modules
