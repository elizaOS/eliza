---
sidebar_position: 2
---

# Quickstart Guide

---

## 1. Simple Start - Get Running Quickly

The fastest way to get started with ElizaOS is using the CLI:

```bash
# Install globally (optional but recommended)
npm install -g @elizaos/cli

# Or use directly with npx
npx elizaos start
```

This will:

1. Start ElizaOS with default settings
2. Load the default character
3. Make the agent accessible via terminal and REST API

### Chat with your agent:

Visit https://localhost:3000 to interact with your agent through a web interface.

## 2. Creating a Project

If you want to create a custom ElizaOS project with your own characters and configurations:

```bash
# Create a new project with the interactive wizard
npx elizaos create

# Or specify project type directly
npx elizaos create --type project
```

Follow the interactive prompts to configure your project. Once created:

```bash
# Navigate to your project directory
cd my-project-name

# Start your project
npx elizaos start
```

### Add plugins to your project:

```bash
# List available plugins
npx elizaos project list-plugins

# Add a plugin
npx elizaos project add-plugin @elizaos-plugins/client-discord
```

## 3. Creating a Plugin

Want to extend ElizaOS with custom functionality?

```bash
# Create a new plugin project
npx elizaos create --type plugin

# Follow the interactive prompts
```

Develop your plugin following the structure in your generated project:

```bash
# Test your plugin
npx elizaos start

# Publish your plugin when ready
npx elizaos plugin publish
```

### Publishing options:

```bash
# Test publish without making changes
npx elizaos plugin publish --test

# Publish to npm
npx elizaos plugin publish --npm

# Specify platform compatibility
npx elizaos plugin publish --platform node
```

## 4. Contributing to ElizaOS

If you want to add features or fix bugs in the ElizaOS core:

```bash
# Clone the repository
git clone git@github.com:elizaOS/eliza.git
cd eliza

# Switch to development branch
git checkout develop

# Install dependencies
bun install

# Build the project
bun build

# Start ElizaOS
bun start
```

Visit https://localhost:3000 to interact with your agent through a web interface.

### Automated setup:

```bash
git clone git@github.com:elizaOS/eliza.git
cd eliza

# Run the start script with verbose logging
./scripts/start.sh -v
```

---

## Troubleshooting

<details>
<summary>Common Issues</summary>

### Node Version

- Use Node.js 23.3.0+ (`node -v` to check)
- Try using NVM: `nvm use 23`

### Installation Problems

```bash
# Clean and reinstall
bun clean
bun install --no-frozen-lockfile
bun build
```

### Plugin Issues

```bash
# Rebuild problematic packages
bun rebuild better-sqlite3
```

### Docker Issues

```bash
# Clean up Docker environment
docker rmi -f $(docker images -aq)
docker builder prune -a -f
```

</details>

---

## Next Steps

Once you have your agent running, explore:

1. 🤖 [Understand Agents](./core/agents.md)
2. 📝 [Create Custom Characters](./core/characterfile.md)
3. ⚡ [Add Custom Actions](./core/actions.md)
4. 🔧 [Advanced Configuration](./guides/configuration.md)

Join the [Discord community](https://discord.gg/elizaOS) for support and to share what you're building!
