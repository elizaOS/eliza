# @elizaos/plugin-video-generation

## Purpose

A plugin for AI-powered video generation using Luma AI, providing automated video creation capabilities from text prompts.

## Key Features

- Generate videos from text descriptions
- Handle video generation requests through Luma AI
- Manage API authentication and responses
- Cache and serve generated videos
- Monitor generation progress

## Installation

```bash
bun install @elizaos/plugin-video-generation
```

## Configuration

The plugin requires the following environment variables:

```env
LUMA_API_KEY=your_luma_api_key    # Required: API key for Luma AI
```

## Integration

Import and register the plugin in your Eliza configuration:

```typescript
import { videoGenerationPlugin } from '@elizaos/plugin-video-generation';

export default {
  plugins: [videoGenerationPlugin],
  // ... other configuration
};
```

## Example Usage

```typescript
// Basic video generation
const videoPrompt = 'Create a video of a futuristic city at night';
const result = await generateVideo(videoPrompt, runtime);

// With callback handling
videoGeneration.handler(
  runtime,
  {
    content: { text: videoPrompt },
  },
  state,
  {},
  (response) => {
    console.log('Generation status:', response);
  }
);
```
