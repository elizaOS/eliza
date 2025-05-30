---
sidebar_position: 10
title: Setup Monorepo Command
description: Clone the ElizaOS monorepo for development or contribution
keywords: [monorepo, setup, clone, git, development, contribution]
image: /img/cli.jpg
---

# Setup Monorepo Command

Clone ElizaOS monorepo from a specific branch, defaults to main.

## Usage

```bash
elizaos setup-monorepo [options]
```

## Options

| Option                  | Description           | Default      |
| ----------------------- | --------------------- | ------------ |
| `-b, --branch <branch>` | Branch to clone       | `main` |
| `-d, --dir <directory>` | Destination directory | `./eliza`    |

## How It Works

1. **Checks Destination**: Verifies the target directory is empty or doesn't exist
2. **Clones Repository**: Downloads the `elizaOS/eliza` repository from GitHub
3. **Shows Next Steps**: Displays instructions for getting started

## Examples

### Basic Usage

```bash
# Clone default branch (main) to default directory (./eliza)
elizaos setup-monorepo

# Clone with verbose output
elizaos setup-monorepo --dir ./eliza --branch main
```

### Custom Branch

```bash
# Clone main branch
elizaos setup-monorepo --branch main

# Clone feature branch for testing
elizaos setup-monorepo --branch feature/new-api

# Clone release branch
elizaos setup-monorepo --branch v2.1.0
```

### Custom Directory

```bash
# Clone to custom directory
elizaos setup-monorepo --dir my-eliza-dev

# Clone to current directory (must be empty)
elizaos setup-monorepo --dir .

# Clone to nested path
elizaos setup-monorepo --dir ./projects/eliza-fork
```

### Development Workflows

```bash
# For contribution development
elizaos setup-monorepo --branch main --dir ./eliza-contrib

# For stable development
elizaos setup-monorepo --branch main --dir ./eliza-stable

# For testing specific features
elizaos setup-monorepo --branch feature/new-plugin-system
```

## After Setup

Once cloned, follow these steps:

```bash
cd eliza                           # Navigate to the cloned directory
bun i && bun run build            # Install dependencies and build
```

### Development Commands

```bash
# Start development server
bun run dev

# Run tests
bun test

# Build all packages
bun run build

# Start a specific package
cd packages/client-web
bun dev
```

## Monorepo Structure

The cloned repository includes:

```
eliza/
├── packages/
│   ├── core/              # Core ElizaOS functionality
│   ├── client-web/        # Web interface
│   ├── client-discord/    # Discord client
│   ├── plugin-*/          # Various plugins
│   └── cli/              # CLI tool source
├── docs/                 # Documentation
├── examples/             # Example projects
└── scripts/              # Build and utility scripts
```

## Use Cases

### Contributors

Perfect for developers wanting to:

- Submit pull requests
- Develop new plugins
- Fix bugs or add features
- Understand the codebase

### Advanced Users

Useful for users who need:

- Custom builds
- Experimental features
- Local plugin development
- Integration testing

### Plugin Developers

Essential for:

- Plugin development and testing
- Understanding plugin APIs
- Contributing to core functionality

## Troubleshooting

### Clone Failures

```bash
# If git clone fails, check network connection
git --version
ping github.com

# For authentication issues
git config --global credential.helper store
```

### Directory Issues

```bash
# If directory is not empty
ls -la ./eliza              # Check contents
rm -rf ./eliza              # Remove if safe
elizaos setup-monorepo      # Retry

# For permission issues
sudo chown -R $USER:$USER ./eliza
```

### Build Failures

```bash
# If dependencies fail to install
cd eliza
rm -rf node_modules
bun install

# If build fails
bun run clean
bun install
bun run build
```

### Branch Not Found

```bash
# List available branches
git ls-remote --heads https://github.com/elizaOS/eliza

# Use correct branch name
elizaos setup-monorepo --branch main
```

## Notes

- The destination directory must be empty or non-existent
- Uses the official `elizaOS/eliza` repository from GitHub
- Requires Git to be installed on your system
- Internet connection required for cloning

## Related Commands

- [`create`](./create.md): Create a new project or plugin from templates
- [`plugins`](./plugins.md): Manage plugins in your project
- [`dev`](./dev.md): Run development server for your projects
