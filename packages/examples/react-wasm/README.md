# ELIZA React WASM Example

A React implementation of the classic ELIZA chatbot powered by **elizaOS Rust WASM runtime**, featuring a beautiful retro CRT terminal interface.

## Overview

This example demonstrates:

- **Rust WASM Runtime**: Core agent logic runs in WebAssembly compiled from Rust
- **Classic ELIZA Plugin**: Pattern matching model handler (no LLM required)
- **LocalDB Storage**: Browser localStorage-based persistence via plugin-localdb
- **Retro CRT aesthetic**: Phosphor green text, scanlines, and glow effects
- **Fully client-side**: No server needed

## Quick Start

```bash
# From the repository root, install all dependencies
bun install

# Build the Rust WASM module (first time only)
cd packages/rust
./build-wasm.sh
cd ../../..

# Navigate to this example
cd examples/react-wasm

# Copy the WASM module to public folder
mkdir -p public/wasm
cp ../../packages/rust/pkg/elizaos_bg.wasm public/wasm/

# Start development server
bun dev
```

The app will open at http://localhost:5173

## Architecture

This example uses the Rust WASM elizaOS runtime:

```
┌─────────────────────────────────────────────────────────────┐
│                     React Application                        │
│                         (App.tsx)                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    eliza-runtime.ts                          │
│              (WASM Runtime singleton manager)                │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│    WasmAgentRuntime      │    │  Plugin Integration      │
│    (Rust → WebAssembly)  │    │                          │
│                          │    │  ┌────────────────────┐  │
│  • Message processing    │◄───┤  │ plugin-eliza-classic│  │
│  • State management      │    │  │ (Pattern matching) │  │
│  • Model handler calls   │    │  └────────────────────┘  │
│                          │    │                          │
│                          │    │  ┌────────────────────┐  │
│                          │    │  │ plugin-localdb     │  │
│                          │    │  │ (localStorage)     │  │
│                          │    │  └────────────────────┘  │
└──────────────────────────┘    └──────────────────────────┘
```

### Plugins Used

1. **@elizaos/plugin-eliza-classic**: Provides TEXT_LARGE/TEXT_SMALL model handlers using classic ELIZA pattern matching
2. **@elizaos/plugin-localdb**: Simple JSON-based storage using browser localStorage

## How It Works

### Rust WASM Runtime

The core agent runtime is compiled from Rust to WebAssembly:

- **WasmAgentRuntime**: Handles message processing, state management, and coordination
- **Model handlers**: Registered from JavaScript and called by the Rust runtime
- **Cross-language bridge**: JSON serialization for passing data between Rust and JavaScript

### Pattern Matching (plugin-eliza-classic)

This implementation uses the original ELIZA pattern matching algorithm from Joseph Weizenbaum's 1966 program:

1. **Keywords**: Input is scanned for keywords with associated weights
2. **Patterns**: Each keyword has regex patterns to match against
3. **Transformations**: Captured groups are reflected (I → you, my → your)
4. **Responses**: Random responses from templates avoid repetition

### LocalDB Storage (plugin-localdb)

Conversations are persisted using browser localStorage:

- Messages are stored as JSON in localStorage
- HNSW index for vector search (if embeddings are used)
- No SQL database required

### No LLM Required

Unlike modern chatbots, classic ELIZA uses purely rule-based pattern matching. This makes it:

- **Instant responses** (no API calls)
- **Works offline** (all logic is client-side)
- **Historically accurate** to the original 1966 program

## Project Structure

```
examples/react-wasm/
├── public/
│   └── wasm/
│       └── elizaos_bg.wasm   # Rust WASM module (copy from core/rust/pkg)
├── src/
│   ├── main.tsx              # React entry point
│   ├── App.tsx               # Main chat component
│   ├── App.css               # Terminal styling
│   ├── index.css             # Global styles
│   └── eliza-runtime.ts      # WASM Runtime singleton manager
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Styling

The UI features:

- VT323 and Fira Code fonts
- Phosphor green (#39ff14) color scheme
- CRT monitor bezel with LED indicators
- Animated scanlines and screen glow
- Boot sequence animation
- Typing indicators

## Building for Production

```bash
# Ensure WASM module is copied
mkdir -p public/wasm
cp ../../packages/rust/pkg/elizaos_bg.wasm public/wasm/

# Build
bun run build
```

Output will be in the `dist/` directory.

## Extending This Example

### Adding More Model Providers

You can add additional model handlers when initializing the runtime:

```typescript
// Register an LLM model handler
runtime.registerModelHandler("TEXT_LARGE", async (paramsJson) => {
  const params = JSON.parse(paramsJson);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5",
      messages: [{ role: "user", content: params.prompt }],
    }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
});
```

### Using Different Storage

Replace plugin-localdb with plugin-sql for PostgreSQL-compatible storage:

```typescript
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";

// Use PGLite for in-browser PostgreSQL
const runtime = new AgentRuntime({
  character: elizaCharacter,
  plugins: [sqlPlugin, elizaClassicPlugin],
});
```

## About Classic ELIZA

ELIZA was created by Joseph Weizenbaum at MIT in 1966. It simulates a Rogerian psychotherapist by:

- Reflecting statements back as questions
- Using keyword-based pattern matching
- Creating the illusion of understanding through clever rephrasing

This "ELIZA effect" - where people attribute human-like understanding to simple pattern matching - remains relevant in discussions about AI today.

## Why Rust WASM?

Using the Rust WASM runtime provides:

- **Type safety**: Rust's strong type system catches bugs at compile time
- **Performance**: Native-like performance for message processing
- **Cross-platform**: Same core runs in browser, Node.js, and native
- **Memory safety**: No garbage collection pauses, predictable performance

## License

MIT
