# elizaOS React Example

A React chat client powered by **elizaOS**, running a full `AgentRuntime` in the
browser with a retro CRT terminal interface. Inference is handled by a real LLM
provider selected from whichever API key environment variable is set.

## Overview

This example demonstrates:

- **elizaOS Integration**: Full AgentRuntime with plugin architecture
- **Provider auto-selection**: Picks an LLM provider from the API key env var
  that is set (OpenAI → OpenRouter → Anthropic → Eliza Cloud)
- **PGLite Database**: In-browser PostgreSQL-compatible storage (WASM)
- **Retro CRT aesthetic**: Phosphor green text, scanlines, and glow effects

## Quick Start

```bash
# From the repository root, install all dependencies
bun install

# Navigate to this example
cd packages/examples/react

# Provide an inference provider key (any ONE of these), then start the dev server
OPENAI_API_KEY=sk-... bun dev
# or OPENROUTER_API_KEY=... / ANTHROPIC_API_KEY=... / ELIZA_API_KEY=...
```

The app will open at http://localhost:5173

> The selected key is injected into the client bundle at build time so the
> in-browser runtime can call the provider. If no key is set, the runtime throws
> a clear error at boot.

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
│     plugin-sql           │    │   inference provider     │
│    (PGLite adapter)      │    │  (openai / openrouter /  │
│                          │    │   anthropic / elizacloud)│
│  In-browser PostgreSQL   │    │                          │
│  with persistent storage │    │  TEXT_LARGE / TEXT_SMALL │
└──────────────────────────┘    └──────────────────────────┘
```

### Plugins Used

1. **@elizaos/plugin-sql**: Provides the PGLite database adapter for in-browser
   persistence.
2. **One inference provider plugin**, chosen at runtime from the available API
   key:
   - `@elizaos/plugin-openai` (`OPENAI_API_KEY`)
   - `@elizaos/plugin-openrouter` (`OPENROUTER_API_KEY`)
   - `@elizaos/plugin-anthropic` (`ANTHROPIC_API_KEY`)
   - `@elizaos/plugin-elizacloud` (`ELIZA_API_KEY`)

## How It Works

### Provider selection (eliza-runtime.ts)

At initialization the runtime checks the environment in priority order and
lazily imports the matching provider plugin:

```typescript
if (process.env.OPENAI_API_KEY) {
  const { openaiPlugin } = await import("@elizaos/plugin-openai");
  // ... register openaiPlugin, set the OPENAI_API_KEY character secret
}
// ... then OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ELIZA_API_KEY
```

The selected provider's API key is set as the character secret the plugin reads
at init (the Eliza Cloud plugin reads `ELIZAOS_CLOUD_API_KEY`, mapped from
`ELIZA_API_KEY`). If none of the keys are set, the runtime throws:

```
No inference provider configured. Set one of OPENAI_API_KEY,
OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or ELIZA_API_KEY.
```

### elizaOS Integration

When the runtime processes a user message via
`runtime.messageService.handleMessage(...)`, it routes the model calls
(`TEXT_LARGE` / `TEXT_SMALL`) to the selected provider plugin. The chat persona
(a Rogerian-style listener) is defined by the character `system` prompt.

## Project Structure

```
examples/react/
├── src/
│   ├── main.tsx               # React entry point
│   ├── App.tsx                # Main chat component
│   ├── App.css                # Terminal styling
│   ├── index.css              # Global styles
│   ├── eliza-runtime.ts       # AgentRuntime singleton + provider selection
│   └── pglite-browser.ts      # Browser PGLite asset loader
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
bun run test
bun run typecheck
bun run build
```

The local smoke test checks the Vite mount point, the lazy browser runtime
import, the provider-selection wiring, and the PGlite storage setup. Production
output will be in the `dist/` directory. The provider key is read from the build
environment, so set it before running `bun run build`.

## Extending This Example

### Swapping providers

Set a different API key env var and restart — the runtime selects the highest
priority provider whose key is present. To change the priority or add a new
provider, edit `selectInferenceProvider` in `src/eliza-runtime.ts`.

### Adding Bootstrap Actions

The bootstrap plugin (actions, providers, services) is automatically included in
the elizaOS core runtime. No need to manually import or configure it — it is
built-in and auto-registered during initialization.

## License

MIT
