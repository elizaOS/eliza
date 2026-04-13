# Chat with Webpage - Browser Extension

A cross-platform browser extension that lets you chat with any webpage using AI. Powered by ElizaOS with support for multiple AI providers.

## Features

- **Chat with any webpage** - Ask questions about the content you're viewing
- **Multiple AI providers** - OpenAI, Anthropic (Claude), Google Gemini, Groq, xAI (Grok), or offline ELIZA
- **Privacy-focused** - API keys stored locally, page content never leaves your browser
- **Streaming responses** - See AI responses as they're generated
- **Cross-platform** - Works on Chrome and Safari

## Quick Start

### Chrome Extension

```bash
# Navigate to the chrome directory
cd chrome

# Install dependencies
npm install

# Build the extension
npm run build

# Load in Chrome:
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the `chrome/` folder
```

### Safari Extension

See [safari/README.md](safari/README.md) for Safari-specific build instructions. Safari extensions require Xcode and must be converted from the Chrome extension.

```bash
# First build the Chrome extension
cd chrome && npm install && npm run build

# Then convert for Safari
cd ../safari
npm run convert

# Open in Xcode and build
```

## Supported AI Providers

| Provider | API Key Required | Models |
|----------|-----------------|--------|
| ELIZA (Classic) | No | Pattern matching (offline) |
| OpenAI | Yes | GPT-4o, GPT-4o-mini |
| Anthropic | Yes | Claude Sonnet, Claude Haiku |
| Google Gemini | Yes | Gemini 2.0 Flash |
| Groq | Yes | Llama 3.3 70B, Llama 3.1 8B |
| xAI (Grok) | Yes | Grok-3, Grok-3-mini |

## Usage

1. **Install the extension** following the instructions above
2. **Navigate to any webpage** you want to chat about
3. **Click the extension icon** in your browser toolbar
4. **Configure your AI provider** (click the settings gear icon)
   - Select your preferred provider
   - Enter your API key if required
5. **Start chatting!** Ask questions about the page content

### Example Questions

- "What is this page about?"
- "Summarize the main points"
- "What are the key features mentioned?"
- "Explain [specific term] from this page"
- "What are the pros and cons discussed?"

## Architecture

```
browser-extension/
├── shared/                     # Shared TypeScript code
│   ├── types.ts               # Type definitions
│   ├── eliza-runtime.ts       # ElizaOS runtime setup
│   └── providers/
│       └── pageContentProvider.ts  # Page context injection
├── chrome/                     # Chrome extension
│   ├── manifest.json          # Extension manifest (MV3)
│   ├── popup.html/css         # Chat UI
│   ├── src/
│   │   ├── popup.ts           # Popup logic
│   │   ├── background.ts      # Service worker
│   │   └── content.ts         # Page content extraction
│   └── package.json
├── safari/                     # Safari extension
│   ├── README.md              # Safari build instructions
│   └── package.json
└── README.md                   # This file
```

### How It Works

1. **Content Script** (`content.ts`) - Runs on every page and extracts the main content (title, URL, text)
2. **Background Script** (`background.ts`) - Manages communication between popup and content scripts
3. **Popup** (`popup.ts`) - The chat interface that users interact with
4. **Page Content Provider** - A custom ElizaOS provider that injects the current page content into the AI's context
5. **Eliza Runtime** - Manages the AI conversation with support for multiple providers

## Development

### Chrome Development

```bash
cd chrome

# Watch mode - rebuilds on file changes
npm run dev

# In Chrome, reload the extension after changes
```

### Debugging

- **Chrome**: Open chrome://extensions, find the extension, click "Inspect views: service worker" or "popup"
- **Safari**: Develop menu > Web Extension Background Pages

## Privacy & Security

- **API keys** are stored in your browser's local storage and never sent to our servers
- **Page content** is processed locally and sent directly to your chosen AI provider
- **No tracking** - the extension doesn't collect any usage data
- **Open source** - review the code yourself

## Troubleshooting

### Extension not working on a page

Some pages block content scripts:
- `chrome://` pages
- Chrome Web Store pages
- Some secure banking/payment sites

### API errors

- Check your API key is correct
- Verify you have available credits/quota with your provider
- Some providers may have rate limits

### Page content not extracted

If the page content seems empty:
- Wait for the page to fully load
- Some SPAs may need a page refresh
- Dynamic content loaded after page load may not be captured

## License

MIT - See the root LICENSE file.
