# Stagehand Server

This is a standalone WebSocket server that handles browser automation using
Stagehand and Playwright. It's designed to run as a separate process from the
main ElizaOS runtime to avoid dependency conflicts with Bun.

## Architecture

The server runs as a separate Node.js process and communicates with the
Stagehand plugin via WebSocket. This architecture allows:

1. **Dependency Isolation**: Playwright and Stagehand run in a Node.js
   environment while ElizaOS runs in Bun
2. **Process Management**: The plugin can start/stop the server as needed
3. **Scalability**: Multiple ElizaOS instances can connect to the same server
4. **Flexibility**: The server can be deployed separately or bundled with the
   agent

## Components

- `src/index.ts` - Main WebSocket server entry point
- `src/session-manager.ts` - Manages browser sessions
- `src/message-handler.ts` - Processes WebSocket messages and executes browser
  operations
- `src/logger.ts` - Simple logging utility

## Protocol

The server uses a request/response pattern over WebSocket:

### Request Format

```json
{
  "type": "navigate",
  "requestId": "req-123",
  "sessionId": "session-456",
  "data": {
    "url": "https://example.com"
  }
}
```

### Response Format

```json
{
  "type": "navigated",
  "requestId": "req-123",
  "success": true,
  "data": {
    "url": "https://example.com",
    "title": "Example Domain"
  }
}
```

## Supported Operations

- `createSession` - Create a new browser session
- `destroySession` - Close a browser session
- `navigate` - Navigate to a URL
- `goBack` - Navigate back in history
- `goForward` - Navigate forward in history
- `refresh` - Refresh the current page
- `click` - Click on an element
- `type` - Type text into a field
- `select` - Select an option from a dropdown
- `extract` - Extract data from the page
- `screenshot` - Take a screenshot
- `getState` - Get current page state
- `solveCaptcha` - Detect and solve captchas

## Environment Variables

- `STAGEHAND_SERVER_PORT` - WebSocket server port (default: 3456)
- `BROWSER_HEADLESS` - Run browser in headless mode (default: true)
- `OLLAMA_BASE_URL` - Ollama API URL for vision models
- `OLLAMA_MODEL` - Ollama model to use (default: llama3.2-vision)
- `OPENAI_API_KEY` - OpenAI API key (alternative to Ollama)
- `ANTHROPIC_API_KEY` - Anthropic API key (alternative to Ollama)
- `BROWSERBASE_API_KEY` - Browserbase API key for cloud browsers
- `BROWSERBASE_PROJECT_ID` - Browserbase project ID

## Building

```bash
npm install
npm run build
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## Docker

The server is included in the agentserver Docker image and runs alongside the
main application.
