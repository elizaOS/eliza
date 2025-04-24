# Isaac X Plugin for ElizaOS

## Purpose

This plugin provides integration with the Isaac X API, enabling ElizaOS Agents to reason scientifically using the latest academic research.

## Key Features

- Research question answering with academic citations
- Rate limit management (10 free requests/day)
- Automatic reference tracking

## Installation

```bash
bun add @elizaos/plugin-isaacx
```

## Configuration

1. First, visit [isaacx.ai/docs](https://isaacx.ai/docs) to create your API key.

2. Add your Isaac X API key to your environment variables:

```bash
ISAACX_API_KEY=ix_your_api_key_here
```

3. Register the plugin in your character configuration:

```typescript
import isaacXPlugin from '@elizaos/plugin-isaacx';

const character = {
  plugins: [isaacXPlugin],
};
```

## Integration

The plugin connects to ElizaOS through the character configuration system and provides actions for research question answering.

## Example Usage

```typescript
// Ask a research question
const response = await runtime.processAction('ANSWER_RESEARCH_QUESTION', {
  question: 'What are the latest developments in quantum computing?',
});

// The response will include both the answer and academic citations
console.log('Research Findings:', response.answer);
console.log('Academic Sources:', response.references);
```

## Links

[isaacx.ai/docs](https://isaacx.ai/docs)
