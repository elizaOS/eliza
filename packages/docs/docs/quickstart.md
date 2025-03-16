---
sidebar_position: 2
---

# Quickstart Guide

This guide will help you get started with ElizaOS using the simplest approach.

## Prerequisites

Before getting started with ElizaOS, ensure you have:

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) (version 23.3.0 recommended)
- A code editor ([VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.com/) or [VSCodium](https://vscodium.com) recommended)

> On Windows? We recommend using WSL2 for the best experience: [WSL setup guide](/docs/guides/wsl)

---

## Getting Started with the CLI (Recommended)

The easiest way to get started with ElizaOS is using the CLI tool, which handles all the setup for you.

### 1. Create a New Project

Create a new ElizaOS project with the interactive setup wizard:

```bash
npx @elizaos/cli create
```

Follow the prompts to configure your project:

- Choose a project name
- Select your database option (PGLite for development, PostgreSQL for production)
- Configure basic settings

### 2. Navigate to Your Project

```bash
cd my-elizaos-project  # Replace with your project name
```

### 3. Start Your Agent

```bash
npx @elizaos/cli start
```

This will:

- Initialize the database
- Load your agent configuration
- Set up any plugins
- Start the HTTP server
- Begin processing messages

### 4. Development Mode

For development with hot reloading:

```bash
npx @elizaos/cli dev
```

### 5. Test Your Agent

You can interact with your agent through:

- The web interface at http://localhost:3000
- The REST API at http://localhost:3000/api
- Any configured platform services (Discord, Telegram, etc.)

---

## Adding Plugins

Extend your agent's capabilities by adding plugins:

```bash
# Install a plugin
npx @elizaos/cli plugin add @elizaos/plugin-discord

# List available plugins
npx @elizaos/cli plugin list
```

Common plugins include:

| Plugin                     | Description                   |
| -------------------------- | ----------------------------- |
| `@elizaos/plugin-discord`  | Discord bot integration       |
| `@elizaos/plugin-telegram` | Telegram bot integration      |
| `@elizaos/plugin-twitter`  | Twitter/X integration         |
| `@elizaos/plugin-image`    | Image processing and analysis |
| `@elizaos/plugin-pdf`      | PDF processing                |
| `@elizaos/plugin-browser`  | Web browsing capabilities     |

---

## Environment Configuration

Configure your agent's environment variables:

```bash
# Set an API key
npx @elizaos/cli env set OPENAI_API_KEY your-api-key-here

# View all environment variables
npx @elizaos/cli env list
```

---

## Alternative: Working on the ElizaOS Core (For Contributors)

If you want to contribute to the ElizaOS core or need to modify the framework itself, you can clone the repository and work with it directly.

### Prerequisites for Core Development

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [Bun](https://bun.sh/) package manager
- Git
- Python (mainly for npm installations)
- (Optional) FFmpeg (for audio/video handling)

### Clone and Set Up

```bash
# Clone the repository
git clone https://github.com/elizaOS/eliza.git
cd eliza

# Install dependencies
bun install

# Build the project
bun run build
```

### Run in Development Mode

```bash
# Start in development mode
bun run dev
```

### Build and Run Production

```bash
# Build the project
bun run build

# Start in production mode
bun run start
```

---

## Troubleshooting

### Common CLI Issues

If you encounter issues with the CLI:

1. Ensure Node.js 23.3.0 is installed: `node -v`
2. Try running with the latest version: `npx @elizaos/cli@latest create`
3. Check for error messages in the console output
4. Run with debugging: `DEBUG=elizaos* npx @elizaos/cli start`

### Database Issues

- **PGLite**: If you have issues with PGLite, try deleting the database file and starting again
- **PostgreSQL**: Verify your connection string and database permissions

### Model Provider Issues

If you see errors related to model providers:

1. Check that your API keys are set correctly
2. Verify you have the necessary credits/quota
3. Try running with the `--configure` flag to reset model configuration:
   ```bash
   npx @elizaos/cli start --configure
   ```

---

## Next Steps

Once you have your agent running, explore:

1. [CLI Commands Reference](./cli/overview.md)
2. [Core Concepts](./core/overview.md)
3. [Creating Custom Plugins](./core/plugins.md)
4. [Creating Actions](./core/actions.md)

Join the [Discord community](https://discord.gg/elizaOS) for support and to share what you're building!
