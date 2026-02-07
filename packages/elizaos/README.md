# elizaOS CLI

Create and manage elizaOS example projects.

## Installation

```bash
# Using npx (no installation required)
npx elizaos create

# Using bunx (no installation required)
bunx elizaos create

# Or install globally
npm install -g elizaos
```

## Commands

### `elizaos version`

Display version information.

```bash
elizaos version
```

### `elizaos info`

Display information about available examples.

```bash
# Show all examples
elizaos info

# Filter by language
elizaos info --language typescript
elizaos info --language python
elizaos info --language rust

# Output as JSON
elizaos info --json
```

### `elizaos create`

Create a new elizaOS example project.

```bash
# Interactive mode
elizaos create

# With project name
elizaos create my-project

# With options
elizaos create my-project --language typescript --example chat

# Skip prompts
elizaos create my-chat --language python --example chat --yes
```

## Available Examples

| Example        | Description                        | Languages                |
| -------------- | ---------------------------------- | ------------------------ |
| chat           | Interactive CLI chat with AI agent | TypeScript, Python, Rust |
| text-adventure | Text adventure game with AI        | TypeScript, Python, Rust |
| tic-tac-toe    | Tic-tac-toe game demo              | TypeScript, Python       |
| rest-api       | REST API implementations           | TypeScript, Python, Rust |
| a2a            | Agent-to-Agent communication       | TypeScript, Python, Rust |
| mcp            | Model Context Protocol             | TypeScript, Python, Rust |
| react          | React web application              | TypeScript               |
| next           | Next.js application                | TypeScript               |
| aws            | AWS Lambda deployment              | TypeScript, Python, Rust |
| gcp            | Google Cloud Platform              | TypeScript, Python, Rust |
| cloudflare     | Cloudflare Workers                 | TypeScript, Python, Rust |
| vercel         | Vercel Edge Functions              | TypeScript, Python, Rust |

## Development

```bash
# Build the CLI
bun run build

# Run locally
bun run src/cli.ts version
bun run src/cli.ts info
bun run src/cli.ts create
```

## License

MIT
