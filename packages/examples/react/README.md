# ELIZA React Example

A React implementation of the classic ELIZA chatbot powered by **elizaOS**, featuring a beautiful retro CRT terminal interface.

## Overview

This example demonstrates:

- **elizaOS Integration**: Full AgentRuntime with plugin architecture
- **Classic ELIZA Plugin**: Pattern matching model handler (no LLM required)
- **PGLite Database**: In-browser PostgreSQL-compatible storage
- **Retro CRT aesthetic**: Phosphor green text, scanlines, and glow effects
- **Fully client-side**: No server needed

## Quick Start

```bash
# From the repository root, install all dependencies
bun install

# Navigate to this example
cd examples/react

# Start development server
bun dev
```

The app will open at http://localhost:5173

## Architecture

This example uses the full elizaOS agent framework:

```
┌─────────────────────────────────────────────────────────────┐
│                     React Application                        │
│                         (App.tsx)                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    eliza-runtime.ts                          │
│              (AgentRuntime singleton manager)                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     AgentRuntime                             │
│                    (@elizaos/core)                           │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│     plugin-sql           │    │  plugin-eliza-classic    │
│    (PGLite adapter)      │    │  (Pattern matching)      │
│                          │    │                          │
│  In-browser PostgreSQL   │    │  TEXT_LARGE handler      │
│  with persistent storage │    │  TEXT_SMALL handler      │
└──────────────────────────┘    └──────────────────────────┘
```

### Plugins Used

1. **@elizaos/plugin-sql**: Provides PGLite database adapter for in-browser persistence
2. **plugin-eliza-classic**: Custom plugin that provides TEXT_LARGE/TEXT_SMALL model handlers using classic ELIZA pattern matching

## How It Works

### Pattern Matching (plugin-eliza-classic.ts)

This implementation uses the original ELIZA pattern matching algorithm from Joseph Weizenbaum's 1966 program:

1. **Keywords**: Input is scanned for keywords with associated weights
2. **Patterns**: Each keyword has regex patterns to match against
3. **Transformations**: Captured groups are reflected (I → you, my → your)
4. **Responses**: Random responses from templates avoid repetition

### elizaOS Integration

The classic ELIZA logic is wrapped as an elizaOS plugin that provides model handlers:

```typescript
export const elizaClassicPlugin: Plugin = {
  name: "eliza-classic",
  description: "Classic ELIZA pattern matching psychotherapist",
  priority: 100, // High priority to override other model providers

  models: {
    [ModelType.TEXT_LARGE]: handleTextGeneration,
    [ModelType.TEXT_SMALL]: handleTextSmall,
  },
};
```

When the runtime processes a user message via `runtime.messageService.handleMessage(...)`, it will ultimately route to the classic ELIZA model handlers (TEXT_LARGE/TEXT_SMALL) provided by `plugin-eliza-classic` instead of an LLM API.

### No LLM Required

Unlike modern chatbots, classic ELIZA uses purely rule-based pattern matching. This makes it:

- **Instant responses** (no API calls)
- **Works offline** (all logic is client-side)
- **Historically accurate** to the original 1966 program

## Project Structure

```
examples/react/
├── src/
│   ├── main.tsx               # React entry point
│   ├── App.tsx                # Main chat component
│   ├── App.css                # Terminal styling
│   ├── index.css              # Global styles
│   ├── eliza-runtime.ts       # AgentRuntime singleton manager
│   └── plugin-eliza-classic.ts # ELIZA pattern matching plugin
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
bun run build
```

Output will be in the `dist/` directory.

## Extending This Example

### Adding More Model Providers

You can add additional model providers by creating new plugins. The AgentRuntime will select handlers based on priority:

```typescript
// Example: Add an LLM fallback with lower priority
const llmPlugin: Plugin = {
  name: "llm-fallback",
  priority: 50, // Lower than ELIZA's 100
  models: {
    [ModelType.TEXT_LARGE]: async (runtime, params) => {
      // Call your LLM API here
    },
  },
};
```

### Adding Bootstrap Actions

The bootstrap plugin (actions, providers, evaluators, services) is now automatically included in the elizaOS core runtime. No need to manually import or configure it - it's built-in and auto-registered during initialization.

## About Classic ELIZA

ELIZA was created by Joseph Weizenbaum at MIT in 1966. It simulates a Rogerian psychotherapist by:

- Reflecting statements back as questions
- Using keyword-based pattern matching
- Creating the illusion of understanding through clever rephrasing

This "ELIZA effect" - where people attribute human-like understanding to simple pattern matching - remains relevant in discussions about AI today.

## License

MIT
