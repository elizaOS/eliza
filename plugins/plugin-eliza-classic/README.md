# @elizaos/plugin-eliza-classic

Deterministic ELIZA-style pattern-matching model handlers for [elizaOS](https://github.com/elizaos/eliza) agents. No LLM API key or network access required.

## What it does

This plugin registers model handlers that intercept every text-inference call an Eliza agent makes and replies with keyword-pattern responses modelled after the 1966 ELIZA chatbot. It also provides a stub embedding handler that returns a 1536-dimensional unit vector.

Use cases:

- Offline / zero-cost agent testing without a real LLM.
- CI pipelines that need an agent to produce responses without network calls.
- Demonstrating the elizaOS plugin model with a minimal, dependency-free example.

## Capabilities

| Capability | Detail |
|---|---|
| Text generation | Pattern-matches the user turn using ~16 keyword regexes (mother, feel, think, want, I am, …) and returns a reflective question. Falls back to "Please go on." |
| Embeddings | Returns a fixed 1536-dim unit vector (index 0 = 1, rest = 0). Satisfies the type contract; not semantically meaningful. |

Exported helpers:
- `generateElizaResponse(input: string): string` — run the pattern matcher directly.
- `getElizaGreeting(): string` — returns `"Hello. How are you feeling today?"`.

## Installation

```bash
bun add @elizaos/plugin-eliza-classic
```

## Enabling the plugin

Add it to your agent's plugin list:

```ts
import elizaClassicPlugin from "@elizaos/plugin-eliza-classic";

const agent = new AgentRuntime({
  plugins: [elizaClassicPlugin],
  // ...
});
```

The plugin declares `priority: 200`. If loaded alongside a real LLM plugin, it will win the model-handler election for all `ModelType` variants unless the other plugin declares a higher priority. To use it only as a fallback, load it before (lower index than) any real LLM plugin and ensure that plugin declares `priority > 200`.

## Required configuration

None. No environment variables or API keys needed.

## Building from source

```bash
bun run --cwd plugins/plugin-eliza-classic build
```

Output goes to `dist/`. Browser and Node ESM bundles are produced separately (`index.js` / `index.browser.js`).

