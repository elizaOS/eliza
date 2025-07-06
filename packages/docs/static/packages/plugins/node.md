# @elizaos/plugin-node

## Purpose

Core Node.js plugin for Eliza OS that provides essential services and actions for file operations, media processing, and cloud integrations.

## Key Features

- AWS S3 Integration
- Browser Automation
- Image Processing
- PDF Processing
- Speech Synthesis
- Transcription
- Video Processing
- LLaMA Integration

## Installation

```bash
bun install @elizaos/plugin-node
```

## Configuration

Requires various environment variables depending on services used, including:

- Core Settings: OPENAI_API_KEY
- Voice Settings: ELEVENLABS_XI_API_KEY, ELEVENLABS_MODEL_ID, etc.
- AWS Settings: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.

## Integration

The plugin connects to ElizaOS through registration:

```typescript
import { createNodePlugin } from '@elizaos/plugin-node';
const nodePlugin = createNodePlugin();
elizaos.registerPlugin(nodePlugin);
```

## Example Usage

```typescript
const result = await runtime.executeAction('DESCRIBE_IMAGE', {
  imageUrl: 'path/to/image.jpg',
});
```

## Links

- https://github.com/elizaos-plugins/plugin-pdf
- https://github.com/elizaos-plugins/plugin-llama
- https://github.com/elizaos-plugins/plugin-image
- https://github.com/elizaos-plugins/plugin-aws-s3
- https://github.com/elizaos-plugins/plugin-browser
- https://github.com/elizaos-plugins/plugin-speech-tts
