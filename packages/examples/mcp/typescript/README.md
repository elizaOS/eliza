# elizaOS MCP Agent Server - TypeScript

Exposes an elizaOS agent as an MCP (Model Context Protocol) server using TypeScript.

## Requirements

- Bun 1.0+ (or Node.js 18+)
- OpenAI API key

## Setup

```bash
# Install dependencies
bun install

# Set up environment
export OPENAI_API_KEY=your-api-key
```

## Usage

```bash
# Start the server
bun run start
```

The server runs on stdio and implements the MCP protocol.

## Testing

```bash
bun run test
```

## Claude Desktop Integration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eliza": {
      "command": "bun",
      "args": ["run", "start"],
      "cwd": "/path/to/this/directory",
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

## Available Tools

- `chat` - Send a message to the agent
- `get_agent_info` - Get information about the agent
