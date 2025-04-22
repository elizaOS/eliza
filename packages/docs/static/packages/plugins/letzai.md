# @elizaos/plugin-letzai

## Purpose

A plugin to integrate LetzAI Image Generation capabilities into the elizaos ecosystem, enabling agents to generate images using any LetzAI Models.

## Key Features

- Uses the LetzAI API and any models available to API user
- Introduces its own GENERATE_IMAGE action

## Installation

```bash
bun install @elizaos/plugin-letzai
```

## Configuration

### Environment Variables

```typescript
LETZAI_API_LEY=<Your LetzAI API Key>
LETZAI_MODELS="@hailee, @examplemodel2"
```

## Integration

The plugin can be integrated in character.json:

```json
"plugins": ["../../packages/plugin-letzai/src/index.ts"],
"actions": ["GENERATE_IMAGE"]
```

## Links

- [LetzAI API](https://www.letz.ai/docs/api)
- [Create API Key](https://www.letz.ai/subscription)
