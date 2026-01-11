# @elizaos/plugin-eliza-classic

Classic ELIZA pattern matching plugin for elizaOS. Provides a testable chat response interface for agents without requiring an LLM.

## Overview

This plugin implements Joseph Weizenbaum's original 1966 ELIZA pattern matching algorithm as an elizaOS model provider. It's useful for:

- **Testing**: Validate agent workflows without API costs
- **Development**: Rapid iteration without LLM latency
- **Education**: Understand how pattern matching chatbots work
- **Offline use**: No internet connection required

## Installation

```bash
# TypeScript/JavaScript
bun add @elizaos/plugin-eliza-classic

# Python
pip install elizaos-plugin-eliza-classic

# Rust
cargo add elizaos-plugin-eliza-classic
```

## Usage

### TypeScript

```typescript
import { AgentRuntime, ModelType } from "@elizaos/core";
import { elizaClassicPlugin } from "@elizaos/plugin-eliza-classic";

const runtime = new AgentRuntime({
  character: { name: "ELIZA" },
  plugins: [elizaClassicPlugin],
});

await runtime.initialize();

const response = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "I feel sad today",
});
// => "I am sorry to hear that you are feeling that way."
```

### Python

```python
from elizaos_plugin_eliza_classic import ElizaClassicPlugin

plugin = ElizaClassicPlugin()

response = plugin.generate_response("I feel sad today")
# => "I am sorry to hear that you are feeling that way."

# Or use as elizaOS plugin
from elizaos_plugin_eliza_classic import create_eliza_classic_elizaos_plugin

plugin = create_eliza_classic_elizaos_plugin()
# Pass to AgentRuntime
```

### Rust

```rust
use elizaos_plugin_eliza_classic::ElizaClassicPlugin;

let plugin = ElizaClassicPlugin::new();
let response = plugin.generate_response("I feel sad today");
// => "I am sorry to hear that you are feeling that way."
```

## How It Works

ELIZA uses a keyword-based pattern matching system:

1. **Keywords**: Input is scanned for keywords with associated weights
2. **Pattern Matching**: Each keyword has regex patterns with capture groups
3. **Response Selection**: A random response template is chosen
4. **Pronoun Reflection**: Captured groups have pronouns reflected (I → you, my → your)
5. **Substitution**: Captured text is inserted into the response template

### Example Pattern

```
Keyword: "remember" (weight: 5)
Pattern: /do you remember (.*)/i
Responses:
  - "Did you think I would forget $1?"
  - "Why do you think I should recall $1 now?"
```

Input: "Do you remember my birthday?"
Output: "Did you think I would forget your birthday?"

## Model Types Supported

| Model Type   | Description                 |
| ------------ | --------------------------- |
| `TEXT_LARGE` | Full ELIZA pattern matching |
| `TEXT_SMALL` | Same as TEXT_LARGE          |

## Configuration

No configuration required. The plugin works out of the box.

## Testing

```bash
# TypeScript
npx vitest

# Python
pytest

# Rust
cargo test
```

## License

MIT



