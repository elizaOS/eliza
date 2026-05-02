# elizaOS MCP Agent Server Examples

This directory contains MCP (Model Context Protocol) server implementations that expose an elizaOS agent as an MCP server. This allows any MCP-compatible client (like Claude Desktop, VS Code, etc.) to interact with your AI agent.

**Uses real elizaOS runtime with OpenAI and SQL plugins!**

## Available Examples

| Framework                    | Language   | Directory |
| ---------------------------- | ---------- | --------- |
| @modelcontextprotocol/sdk    | TypeScript | `.`       |

## What is MCP?

The Model Context Protocol (MCP) is an open protocol that standardizes how AI applications communicate with external tools and data sources. By exposing your elizaOS agent as an MCP server, any MCP client can:

- Send messages to your agent
- Receive responses
- Access agent metadata and capabilities

## Common MCP Tools

All implementations expose the same tools:

### `chat`

Send a message to the agent and receive a response.

**Input Schema:**

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The message to send to the agent"
    },
    "userId": {
      "type": "string",
      "description": "Optional user identifier"
    }
  },
  "required": ["message"]
}
```

**Returns:** Agent's response text

### `get_agent_info`

Get information about the agent.

**Returns:** Agent name, bio, and capabilities

## Quick Start

```bash
cd examples/mcp
bun install
OPENAI_API_KEY=your-key bun run start
```

## Configuration

All examples require an OpenAI API key:

```bash
export OPENAI_API_KEY=your-key
```

Optional configuration:

- `MCP_PORT` - Port for HTTP transport (default: 3000)
- `OPENAI_BASE_URL` - Custom OpenAI-compatible endpoint
- `OPENAI_SMALL_MODEL` - Model for quick responses
- `OPENAI_LARGE_MODEL` - Model for complex responses

## Connecting to Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "eliza": {
      "command": "bun",
      "args": ["run", "start"],
      "cwd": "/path/to/eliza/examples/mcp",
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

## Testing

```bash
cd examples/mcp
bun run test
```
