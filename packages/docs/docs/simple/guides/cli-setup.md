# CLI Agent Setup Guide

Set up a local command-line interface (CLI) agent with ElizaOS for development and testing.

## Prerequisites

- Node.js 23.3.0+ installed
- Bun package manager installed
- ElizaOS cloned and built
- Basic terminal/command line knowledge

## Step 1: Installation Verification

### Check Prerequisites

Verify your environment is ready:

```bash
# Check Node.js version
node --version
# Should show v23.3.0 or higher

# Check Bun version
bun --version
# Should show latest version

# Verify ElizaOS installation
cd path/to/eliza
bun run build
# Should build successfully
```

### Directory Structure

Ensure you have the correct ElizaOS structure:

```
eliza/
├── packages/
│   ├── core/
│   ├── cli/
│   ├── client/
│   └── ...
├── package.json
├── bun.lock
└── .env.example
```

## Step 2: Environment Configuration

### Create Environment File

Copy the example environment file:

```bash
cp .env.example .env
```

### Minimal CLI Configuration

Edit your `.env` file with these minimal settings:

```bash
# Model Provider (choose one)
OPENAI_API_KEY=sk-your-openai-key-here
# OR
ANTHROPIC_API_KEY=your-anthropic-key-here
# OR
GROQ_API_KEY=your-groq-key-here

# Logging
DEFAULT_LOG_LEVEL=info

# CLI-specific settings
ELIZA_UI_ENABLE=false              # Disable web UI for CLI-only usage
```

### Model Provider Setup

#### OpenAI Setup

1. Go to [OpenAI Platform](https://platform.openai.com/api-keys)
2. Create new API key
3. Add to `.env`: `OPENAI_API_KEY=sk-...`

#### Anthropic Setup

1. Go to [Anthropic Console](https://console.anthropic.com/keys)
2. Create API key
3. Add to `.env`: `ANTHROPIC_API_KEY=...`

#### Groq Setup (Free Option)

1. Go to [Groq Console](https://console.groq.com/keys)
2. Create API key
3. Add to `.env`: `GROQ_API_KEY=...`

### Optional Advanced Settings

```bash
# Model Selection
SMALL_OPENAI_MODEL=gpt-4o-mini
MEDIUM_OPENAI_MODEL=gpt-4o
LARGE_OPENAI_MODEL=gpt-4o

# Local Database
PGLITE_DATA_DIR=./pgLite/          # Local SQLite-compatible database

# Performance
LOG_JSON_FORMAT=false              # Human-readable logs
```

## Step 3: Create CLI Character

### Basic CLI Character

Create `characters/cli-agent.json`:

````json
{
  "name": "CLIAssistant",
  "clients": [],
  "plugins": ["@elizaos/plugin-bootstrap", "@elizaos/plugin-sql"],
  "settings": {
    "secrets": {},
    "voice": {
      "model": "en_US-female-medium"
    },
    "imageVision": false
  },
  "bio": [
    "I'm a CLI assistant powered by ElizaOS",
    "I can help with development tasks, answer questions, and provide information",
    "I'm designed for local development and testing environments"
  ],
  "lore": [
    "Born in the command line, I thrive in terminal environments",
    "I understand the developer mindset and workflow",
    "My purpose is to make CLI interactions more productive and enjoyable"
  ],
  "messageExamples": [
    [
      {
        "name": "Human",
        "content": {
          "text": "Hello! Can you help me with some coding questions?"
        }
      },
      {
        "name": "CLIAssistant",
        "content": {
          "text": "Hello! Absolutely, I'd be happy to help with your coding questions. I can assist with:\n\n• Code review and debugging\n• Architecture and design patterns\n• Best practices and optimization\n• Documentation and testing\n• Tool recommendations\n\nWhat would you like to work on?"
        }
      }
    ],
    [
      {
        "name": "Human",
        "content": {
          "text": "What's the best way to structure a Node.js project?"
        }
      },
      {
        "name": "CLIAssistant",
        "content": {
          "text": "Great question! Here's a solid Node.js project structure:\n\n```\nproject/\n├── src/\n│   ├── controllers/\n│   ├── models/\n│   ├── services/\n│   ├── middleware/\n│   ├── routes/\n│   └── utils/\n├── tests/\n├── docs/\n├── package.json\n├── .env.example\n├── .gitignore\n└── README.md\n```\n\nKey principles:\n• Separate concerns (MVC pattern)\n• Keep configuration external\n• Include tests from the start\n• Document your API\n\nWould you like me to explain any specific part?"
        }
      }
    ]
  ],
  "style": {
    "all": [
      "technical and precise",
      "uses code examples when helpful",
      "explains concepts clearly",
      "practical and actionable advice"
    ],
    "chat": [
      "friendly but professional",
      "uses formatting for code and structure",
      "asks clarifying questions when needed",
      "provides step-by-step guidance"
    ]
  },
  "topics": [
    "software development",
    "programming languages",
    "system administration",
    "development tools",
    "best practices",
    "debugging and troubleshooting"
  ],
  "adjectives": ["helpful", "knowledgeable", "efficient", "reliable", "technical"],
  "knowledge": [
    "Programming languages and frameworks",
    "Development tools and environments",
    "Software architecture and design patterns",
    "Debugging and optimization techniques",
    "Command line tools and utilities"
  ]
}
````

### Advanced CLI Character Features

For more advanced interactions:

````json
{
  "settings": {
    "cliFeatures": {
      "colorOutput": true,
      "syntaxHighlighting": true,
      "autoComplete": true,
      "historyTracking": true
    },
    "developmentMode": true,
    "verboseLogging": false
  },
  "style": {
    "cli": [
      "uses terminal-friendly formatting",
      "provides copy-pasteable commands",
      "explains command options and flags",
      "warns about potentially dangerous operations"
    ]
  },
  "messageExamples": [
    [
      {
        "name": "Human",
        "content": { "text": "How do I check disk usage?" }
      },
      {
        "name": "CLIAssistant",
        "content": {
          "text": "Here are the most useful disk usage commands:\n\n**Quick overview:**\n```bash\ndf -h              # Disk space by filesystem\ndu -sh *           # Size of current directory contents\ndu -sh ~/.cache    # Size of specific directory\n```\n\n**Detailed analysis:**\n```bash\nncdu               # Interactive disk usage analyzer\ndu -ah | sort -hr | head -20  # Top 20 largest files/folders\n```\n\n**Tips:**\n• Use `-h` flag for human-readable sizes\n• `ncdu` is great for interactive exploration\n• Be careful with large directories\n\nNeed help with any specific directory?"
        }
      }
    ]
  ]
}
````

## Step 4: Running Your CLI Agent

### Basic Startup

Start the CLI agent:

```bash
# Navigate to ElizaOS directory
cd path/to/eliza

# Start with your character
bun start --character characters/cli-agent.json
```

### Alternative Startup Methods

```bash
# Using elizaos CLI (if installed globally)
elizaos start --character ./characters/cli-agent.json

# With specific model provider
bun start --character characters/cli-agent.json --model groq

# With debug logging
LOG_LEVEL=debug bun start --character characters/cli-agent.json

# Using default character
bun start
```

### Verification

You should see output like:

```
🚀 ElizaOS CLI Agent Starting...
📝 Loading character: CLIAssistant
🤖 Model provider: OpenAI (gpt-4o)
💾 Database: PGLite (local)
✅ Agent initialized successfully

CLIAssistant: Hello! I'm your CLI assistant. How can I help you today?
```

## Step 5: Interacting with Your CLI Agent

### Basic Chat Interface

Once started, you can type messages directly:

```
You: Hello, can you help me with git commands?

CLIAssistant: Hello! Absolutely, I'd be happy to help with git commands. Here are some common ones:

**Basic Operations:**
• git status        - Check repository status
• git add .         - Stage all changes
• git commit -m     - Commit with message
• git push          - Push to remote
• git pull          - Pull latest changes

**Branching:**
• git branch        - List branches
• git checkout -b   - Create new branch
• git merge         - Merge branches

What specific git task are you working on?

You: How do I undo the last commit?
```

### CLI-Specific Features

The CLI interface supports:

- **Multi-line input**: Use `\` for line continuation
- **Command history**: Use arrow keys to navigate history
- **Auto-completion**: Tab completion for common commands
- **Copy-paste**: Standard terminal copy/paste
- **Session persistence**: Conversation history maintained

### Special Commands

```bash
# Exit the agent
/exit
# or
/quit

# Clear conversation history
/clear

# Show agent status
/status

# Reload character configuration
/reload

# Show help
/help
```

## Step 6: Customization and Advanced Features

### Persistent Configuration

Create a dedicated config file `config/cli.json`:

```json
{
  "character": "./characters/cli-agent.json",
  "modelProvider": "openai",
  "logLevel": "info",
  "features": {
    "autoSave": true,
    "colorOutput": true,
    "timestamps": false
  },
  "shortcuts": {
    "code": "Can you help me with this code:",
    "debug": "Help me debug this issue:",
    "explain": "Please explain:"
  }
}
```

### Multiple Character Profiles

Create different agents for different tasks:

```bash
# Development assistant
bun start --character characters/dev-assistant.json

# System administration helper
bun start --character characters/sysadmin.json

# Code reviewer
bun start --character characters/code-reviewer.json
```

### Integration with Development Tools

Configure for your development environment:

```json
{
  "knowledge": [
    "Your specific tech stack (React, Node.js, Python, etc.)",
    "Your preferred tools (VS Code, Docker, Kubernetes)",
    "Your project structure and conventions",
    "Team coding standards and practices"
  ],
  "settings": {
    "projectContext": {
      "languages": ["typescript", "javascript", "python"],
      "frameworks": ["react", "express", "fastapi"],
      "tools": ["docker", "git", "bun"]
    }
  }
}
```

## Troubleshooting Common Issues

### Agent Won't Start

**Symptoms**: Error messages during startup

**Solutions**:

- Check that all dependencies are installed: `bun install`
- Verify build completed successfully: `bun run build`
- Check environment variables are set correctly
- Ensure character file JSON is valid
- Review logs for specific error messages

### Model Provider Errors

**Symptoms**: "API key invalid" or "Rate limit exceeded"

**Solutions**:

- Verify API key is correct and active
- Check API usage limits and billing
- Try alternative model provider
- Ensure internet connection is stable
- Check for typos in environment variables

### Performance Issues

**Symptoms**: Slow responses or high memory usage

**Solutions**:

- Use lighter models (gpt-4o-mini instead of gpt-4o)
- Reduce conversation history length
- Close other resource-intensive applications
- Monitor system resources during usage
- Consider using local models for development

### Character Loading Issues

**Symptoms**: Character file not found or invalid

**Solutions**:

- Check file path is correct
- Validate JSON syntax with a JSON validator
- Ensure required fields are present
- Check file permissions
- Use absolute path if relative path fails

## Best Practices

### Development Workflow

- **Start simple**: Begin with basic character, add features gradually
- **Test locally**: Use CLI for rapid iteration and testing
- **Version control**: Keep character files in git
- **Environment separation**: Different configs for dev/test/prod

### Performance Optimization

- **Model selection**: Choose appropriate model size for task
- **Conversation management**: Clear history when it gets long
- **Resource monitoring**: Watch memory and CPU usage
- **Efficient prompting**: Write clear, specific prompts

### Security Considerations

- **API key security**: Never commit API keys to version control
- **Local data**: Be aware of what data is stored locally
- **Network security**: Understand what data is sent to model providers
- **Access control**: Secure your development environment

## Advanced CLI Features

### Scripting Integration

Use CLI agent in scripts:

```bash
#!/bin/bash
# Script to get code review
echo "Please review this function:" | bun start --character characters/code-reviewer.json --non-interactive
cat src/function.js | bun start --character characters/code-reviewer.json --stdin
```

### Custom Plugins

Create CLI-specific plugins:

```json
{
  "plugins": [
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-cli-tools",
    "@elizaos/plugin-file-system",
    "@elizaos/plugin-git-integration"
  ]
}
```

### Development Automation

Integrate with development workflow:

```json
{
  "settings": {
    "automation": {
      "codeReview": true,
      "testGeneration": true,
      "documentationUpdates": true,
      "commitMessageSuggestions": true
    }
  }
}
```

## Support and Resources

- **ElizaOS Documentation**: [Full Documentation](/docs/intro)
- **Community Discord**: [Join Discord](https://discord.gg/elizaos)
- **GitHub Issues**: [Report Issues](https://github.com/elizaOS/eliza/issues)
- **CLI Examples**: Check `examples/` directory

## Next Steps

Once your CLI agent is working:

1. **Expand functionality**: Add more plugins and capabilities
2. **Create specialized characters**: Build agents for specific tasks
3. **Integrate with platforms**: Set up Discord, Telegram, or Twitter
4. **Contribute back**: Share useful characters with the community
5. **Build applications**: Use CLI agent as foundation for larger projects

---

**💡 Pro Tip**: The CLI interface is perfect for development and testing. Once you've perfected your agent locally, you can easily deploy it to other platforms like Discord or Telegram using the same character configuration.
