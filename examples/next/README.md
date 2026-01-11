# ELIZA Next.js Example

A full-stack Next.js chat application using elizaOS AgentRuntime with PGLite and OpenAI.

## Quick Start

```bash
cd examples/next
bun install

# Set OpenAI key and run
OPENAI_API_KEY="your-openai-key" bun run dev
```

Open http://localhost:3000

## How It Works

The API route (`app/api/chat/route.ts`) mirrors `examples/chat/typescript/chat.ts`:

```typescript
const character: Character = {
  name: "Eliza",
  bio: "A helpful AI assistant.",
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
};

const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin, openaiPlugin],
});
await runtime.initialize();

// Handle messages with streaming
await runtime.messageService?.handleMessage(runtime, message, callback);
```

## Key Configuration

### next.config.js

PGLite's WASM extensions require special handling in Next.js:

```javascript
const nextConfig = {
  swcMinify: false,
  transpilePackages: ["@electric-sql/pglite-react", "@electric-sql/pglite"],
  // Exclude PGLite from server-side bundling to preserve file paths
  serverExternalPackages: ["@electric-sql/pglite"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        "@electric-sql/pglite": "commonjs @electric-sql/pglite",
        "@electric-sql/pglite/vector": "commonjs @electric-sql/pglite/vector",
        "@electric-sql/pglite/contrib/fuzzystrmatch":
          "commonjs @electric-sql/pglite/contrib/fuzzystrmatch",
      });
    }
    return config;
  },
};
```

### Character Secrets

Environment variables must be passed via `character.secrets` because `runtime.getSetting()` looks there:

```typescript
const character: Character = {
  name: "Eliza",
  bio: "A helpful AI assistant.",
  secrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  },
};
```

## Project Structure

```
examples/next/
├── app/
│   ├── api/chat/route.ts    # AgentRuntime + streaming
│   ├── page.tsx             # Chat UI
│   └── ...
├── lib/
│   └── eliza-classic.ts     # Classic ELIZA fallback
├── next.config.js           # PGLite webpack config
└── package.json
```

## Environment Variables

| Variable          | Description                      | Required |
| ----------------- | -------------------------------- | -------- |
| `OPENAI_API_KEY`  | OpenAI API key                   | Yes      |
| `PGLITE_DATA_DIR` | PGLite data directory (optional) | No       |

## Optional: PostgreSQL

For production, you can use PostgreSQL instead:

```bash
POSTGRES_URL="postgresql://user:pass@localhost:5432/db" \
OPENAI_API_KEY="your-key" \
bun run dev
```
