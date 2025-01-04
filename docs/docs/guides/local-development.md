---
sidebar_position: 12
---

# 💻 Local Development Guide

This guide covers setting up and working with Eliza in a development environment.

## Prerequisites

Before you begin, ensure you have:

```bash
# Required
Node.js 23+
pnpm
Git

# Optional but recommended
VS Code
Docker (for database development)
CUDA Toolkit (for GPU acceleration)
```

## Initial Setup

### 1. Repository Setup

```bash
# Clone the repository
git clone https://github.com/elizaos/eliza.git
cd eliza

# Install dependencies
pnpm install

# Install optional dependencies
pnpm install --include=optional sharp
```

### 2. Environment Configuration

Create your development environment file:

```bash
cp .env.example .env
```

Configure essential development variables:

```bash
# Minimum required for local development
OPENAI_API_KEY=sk-*           # Optional, for OpenAI features
X_SERVER_URL=                 # Leave blank for local inference
XAI_API_KEY=                 # Leave blank for local inference
XAI_MODEL=meta-llama/Llama-3.1-7b-instruct  # Local model
```

### 3. Local Model Setup

For local inference without API dependencies:

```bash
# Install CUDA support for NVIDIA GPUs
npx --no node-llama-cpp source download --gpu cuda

# The system will automatically download models from
# Hugging Face on first run
```

## Development Workflow

### Running the Development Server

```bash
# Start with default character
pnpm run dev

# Start with specific character
pnpm run dev --characters="characters/my-character.json"

# Start with multiple characters
pnpm run dev --characters="characters/char1.json,characters/char2.json"
```

### Development Commands

```bash
pnpm run build          # Build the project
pnpm run clean         # Clean build artifacts
pnpm run dev           # Start development server
pnpm run test          # Run tests
pnpm run test:watch    # Run tests in watch mode
pnpm run lint          # Lint code
```

### Direct Client Chat UI

```
# Open a terminal and Start with specific character
pnpm run dev --characters="characters/my-character.json"
```

```
# Open a 2nd terminal and start the client
pnpm start:client
```

Look for the message:
`  ➜  Local:   http://localhost:5173/`
Click on that link or open a browser window to that location. Once you do that you should see the chat interface connect with the system and you can start interacting with your character.

## Database Development

### SQLite (Recommended for Development)

```typescript
import { SqliteDatabaseAdapter } from "@elizaos/core/adapters";
import Database from "better-sqlite3";

const db = new SqliteDatabaseAdapter(new Database("./dev.db"));
```

### In-Memory Database (for Testing)

```typescript
import { SqlJsDatabaseAdapter } from "@elizaos/core/adapters";

const db = new SqlJsDatabaseAdapter(new Database(":memory:"));
```

### Schema Management

```bash
# Create new migration
pnpm run migration:create

# Run migrations
pnpm run migration:up

# Rollback migrations
pnpm run migration:down
```

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test tests/specific.test.ts

# Run tests with coverage
pnpm test:coverage

# Run database-specific tests
pnpm test:sqlite
pnpm test:sqljs
```

### Writing Tests

```typescript
import { runAiTest } from "@elizaos/core/test_resources";

describe("Feature Test", () => {
    beforeEach(async () => {
        // Setup test environment
    });

    it("should perform expected behavior", async () => {
        const result = await runAiTest({
            messages: [
                {
                    user: "user1",
                    content: { text: "test message" },
                },
            ],
            expected: "expected response",
        });
        expect(result.success).toBe(true);
    });
});
```

## Plugin Development

### Creating a New Plugin

```typescript
// plugins/my-plugin/src/index.ts
import { Plugin } from "@elizaos/core/types";

export const myPlugin: Plugin = {
    name: "my-plugin",
    description: "My custom plugin",
    actions: [],
    evaluators: [],
    providers: [],
};
```

### Custom Action Development

```typescript
// plugins/my-plugin/src/actions/myAction.ts
export const myAction: Action = {
    name: "MY_ACTION",
    similes: ["SIMILAR_ACTION"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return true;
    },
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        // Implementation
        return true;
    },
    examples: [],
};
```

## Debugging

### VS Code Configuration

Create `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "node",
            "request": "launch",
            "name": "Debug Eliza",
            "skipFiles": ["<node_internals>/**"],
            "program": "${workspaceFolder}/src/index.ts",
            "runtimeArgs": ["-r", "ts-node/register"],
            "env": {
                "DEBUG": "eliza:*"
            }
        }
    ]
}
```

### Debugging Tips

1. Enable Debug Logging

```bash
# Add to your .env file
DEBUG=eliza:*
```

2. Use Debug Points

```typescript
const debug = require("debug")("eliza:dev");

debug("Operation details: %O", {
    operation: "functionName",
    params: parameters,
    result: result,
});
```

3. Memory Debugging

```bash
# Increase Node.js memory for development
NODE_OPTIONS="--max-old-space-size=8192" pnpm run dev
```

## Common Development Tasks

### 1. Adding a New Character

```json
{
    "name": "DevBot",
    "description": "Development testing bot",
    "modelProvider": "openai",
    "settings": {
        "debug": true,
        "logLevel": "debug"
    }
}
```

### 2. Creating Custom Services

```typescript
class CustomService extends Service {
    static serviceType = ServiceType.CUSTOM;

    async initialize() {
        // Setup code
    }

    async process(input: any): Promise<any> {
        // Service logic
    }
}
```

### 3. Working with Models

```typescript
// Local model configuration
const localModel = {
    modelProvider: "llamalocal",
    settings: {
        modelPath: "./models/llama-7b.gguf",
        contextSize: 8192,
    },
};

// Cloud model configuration
const cloudModel = {
    modelProvider: "openai",
    settings: {
        model: "gpt-4o-mini",
        temperature: 0.7,
    },
};
```

## Performance Optimization

### CUDA Setup

For NVIDIA GPU users:

1. Install CUDA Toolkit with cuDNN and cuBLAS
2. Set environment variables:

```bash
CUDA_PATH=/usr/local/cuda  # Windows: C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v11.0
```

### Memory Management

```typescript
class MemoryManager {
    private cache = new Map();
    private maxSize = 1000;

    async cleanup() {
        if (this.cache.size > this.maxSize) {
            // Implement cleanup logic
        }
    }
}
```

## Troubleshooting

### Common Issues

1. Model Loading Issues

```bash
# Clear model cache
rm -rf ./models/*
# Restart with fresh download
```

2. Database Connection Issues

```bash
# Test database connection
pnpm run test:db-connection
```

3. Memory Issues

```bash
# Check memory usage
node --trace-gc index.js
```

### Development Tools

```bash
# Generate TypeScript documentation
pnpm run docs:generate

# Check for circular dependencies
pnpm run madge

# Analyze bundle size
pnpm run analyze
```

## Best Practices

1. Code Organization

    - Place custom actions in `custom_actions/`
    - Keep character files in `characters/`
    - Store test data in `tests/fixtures/`

2. Testing Strategy

    - Write unit tests for new features
    - Use integration tests for plugins
    - Test with multiple model providers

3. Git Workflow
    - Create feature branches
    - Follow conventional commits
    - Keep PRs focused

## Additional Tools

### Character Development

```bash
# Generate character from Twitter data
npx tweets2character

# Convert documents to knowledge base
npx folder2knowledge <path/to/folder>

# Add knowledge to character
npx knowledge2character <character-file> <knowledge-file>
```

### Development Scripts

```bash
# Analyze codebase
./scripts/analyze-codebase.ts

# Extract tweets for training
./scripts/extracttweets.js

# Clean build artifacts
./scripts/clean.sh
```

## Further Resources

- [Configuration Guide](./configuration.md) for setup details
- [Advanced Usage](./advanced.md) for complex features
- [API Documentation](/api) for complete API reference
- [Contributing Guide](../contributing.md) for contribution guidelines
