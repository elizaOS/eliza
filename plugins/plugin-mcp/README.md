# MCP Plugin for elizaOS

[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-blue.svg)](https://conventionalcommits.org)

This plugin integrates the Model Context Protocol (MCP) with elizaOS, allowing agents to connect to multiple MCP servers and use their resources, prompts, and tools.

## 🔍 What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is an open protocol that enables seamless integration between LLM applications and external data sources and tools. It provides a standardized way to connect LLMs with the context they need.

This plugin allows your elizaOS agents to access multiple MCP servers simultaneously, each providing different capabilities:

- **Resources**: Context and data for the agent to reference
- **Tools**: Functions for the agent to execute

## 📦 Installation

Install the plugin in your elizaOS project:

- **npm**

```bash
npm install @elizaos/plugin-mcp
```

- **pnpm**

```bash
pnpm install @elizaos/plugin-mcp
```

- **yarn**

```bash
yarn add @elizaos/plugin-mcp
```

- **bun**

```bash
bun add @elizaos/plugin-mcp
```

## 🚀 Usage

1. Add the plugin to your character configuration:

```json
{
  "name": "Your Character",
  "plugins": ["@elizaos/plugin-mcp"],
  "settings": {
    "mcp": {
      "servers": {
        "github": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"]
        }
      }
    }
  }
}
```

## ⚙️ Configuration Options

MCP supports multiple transport types for connecting to servers. Each type has its own configuration options.

### Transport Types

- **`streamable-http`** or **`http`** - Streamable HTTP transport (recommended)
- **`sse`** - Server-Sent Events transport
- **`stdio`** - Process-based transport using standard input/output

### HTTP Transport Options (streamable-http, http, sse)

| Option    | Type   | Description                                         |
| --------- | ------ | --------------------------------------------------- |
| `type`    | string | Transport type: "streamable-http", "http", or "sse" |
| `url`     | string | The URL of the HTTP/SSE endpoint                    |
| `timeout` | number | _Optional_ Timeout for connections                  |

### stdio Transport Options

| Option            | Type     | Description                                            |
| ----------------- | -------- | ------------------------------------------------------ |
| `type`            | string   | Must be "stdio"                                        |
| `command`         | string   | _Optional_ The command to run the MCP server           |
| `args`            | string[] | _Optional_ Command-line arguments for the server       |
| `env`             | object   | _Optional_ Environment variables to pass to the server |
| `cwd`             | string   | _Optional_ Working directory to run the server in      |
| `timeoutInMillis` | number   | _Optional_ Timeout in milliseconds for tool calls      |

### Example Configuration

```json
{
  "mcp": {
    "servers": {
      "my-http-server": {
        "type": "streamable-http",
        "url": "https://example.com/mcp"
      },
      "my-local-server": {
        "type": "http",
        "url": "http://localhost:3000",
        "timeout": 30
      },
      "my-sse-server": {
        "type": "sse",
        "url": "http://localhost:8080"
      },
      "my-stdio-server": {
        "type": "stdio",
        "command": "mcp-server",
        "args": ["--config", "config.json"],
        "cwd": "/path/to/server",
        "timeoutInMillis": 60000
      }
    },
    "maxRetries": 3
  }
}
```

## 🛠️ Using MCP Capabilities

Once configured, the plugin automatically exposes MCP servers' capabilities to your agent:

### Context Provider

The plugin includes one provider that adds MCP capabilities to the agent's context:

1. **`MCP`**: Lists available servers and their tools and resources

### Actions

The plugin provides two actions for interacting with MCP servers:

1. **`CALL_MCP_TOOL`**: Executes tools from connected MCP servers
2. **`READ_MCP_RESOURCE`**: Accesses resources from connected MCP servers

## 🔄 Plugin Flow

The following diagram illustrates the MCP plugin's flow for tool selection and execution:

```mermaid
graph TD
    %% Starting point - User request
    start[User Request] --> action[CALL_MCP_TOOL Action]

    %% MCP Server Validation
    action --> check{MCP Servers Available?}
    check -->|No| fail[Return No Tools Available]

    %% Tool Selection Flow
    check -->|Yes| state[Get MCP Provider Data]
    state --> prompt[Create Tool Selection Prompt]

    %% First Model Use - Tool Selection
    prompt --> model1[Use Language Model for Tool Selection]
    model1 --> parse[Parse Selection]
    parse --> retry{Valid Selection?}

    %% Second Model Use - Retry Selection
    retry -->|No| feedback[Generate Feedback]
    feedback --> model2[Use Language Model for Retry]
    model2 --> parse

    %% Tool Selection Result
    retry -->|Yes| toolAvailable{Tool Available?}
    toolAvailable -->|No| fallback[Fallback Response]

    %% Tool Execution Flow
    toolAvailable -->|Yes| callTool[Call MCP Tool]
    callTool --> processResult[Process Tool Result]

    %% Memory Creation
    processResult --> createMemory[Create Memory Record]
    createMemory --> reasoningPrompt[Create Reasoning Prompt]

    %% Third Model Use - Response Generation
    reasoningPrompt --> model3[Use Language Model for Response]
    model3 --> respondToUser[Send Response to User]

    %% Styling
    classDef model fill:#f9f,stroke:#333,stroke-width:2px;
    classDef decision fill:#bbf,stroke:#333,stroke-width:2px;
    classDef output fill:#bfb,stroke:#333,stroke-width:2px;

    class model1,model2,model3 model;
    class check,retry,toolAvailable decision;
    class respondToUser,fallback output;
```

## 📋 Example: Setting Up Multiple MCP Servers

Here's a complete example configuration with multiple MCP servers of both types:

```json
{
  "name": "Developer Assistant",
  "plugins": ["@elizaos/plugin-mcp", "other-plugins"],
  "settings": {
    "mcp": {
      "servers": {
        "github": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": {
            "GITHUB_PERSONAL_ACCESS_TOKEN": "<YOUR_TOKEN>"
          }
        },
        "puppeteer": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
        },
        "google-maps": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-google-maps"],
          "env": {
            "GOOGLE_MAPS_API_KEY": "<YOUR_API_KEY>"
          }
        }
      },
      "maxRetries": 2
    }
  }
}
```

## 🔒 Security Considerations

Please be aware that MCP servers can execute arbitrary code, so only connect to servers you trust.

## 🔍 Troubleshooting

If you encounter issues with the MCP plugin:

1. Check that your MCP servers are correctly configured and running
2. Ensure the commands are accessible in the elizaOS environment
3. Review the logs for connection errors
4. Verify that the plugin is properly loaded in your character configuration

## 👥 Contributing

Thanks for considering contributing to our project!

### How to Contribute

1. Fork the repository.
2. Create a new branch: `git checkout -b feature-branch-name`.
3. Make your changes.
4. Commit your changes using conventional commits.
5. Push to your fork and submit a pull request.

### Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/) for our commit messages:

- `test`: 💍 Adding missing tests
- `feat`: 🎸 A new feature
- `fix`: 🐛 A bug fix
- `chore`: 🤖 Build process or auxiliary tool changes
- `docs`: ✏️ Documentation only changes
- `refactor`: 💡 A code change that neither fixes a bug or adds a feature
- `style`: 💄 Markup, white-space, formatting, missing semi-colons...

## 📄 License

This plugin is released under the same license as elizaOS.
