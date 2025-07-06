# @elizaos/plugin-suno

## Purpose

A Suno AI music generation plugin for ElizaOS that enables AI-powered music creation and audio manipulation.

## Key Features

- Generate music from text prompts with fine-tuned parameters
- Create custom music with advanced control over style, tempo, and key
- Extend existing audio tracks

## Installation

```
bun install @elizaos/plugin-suno
```

## Configuration

```typescript
sunoProvider.configure({
  apiKey: 'your-suno-api-key',
});
```

## Integration

Register the plugin with ElizaOS:

```typescript
import { sunoPlugin } from '@elizaos/plugin-suno';
import { Eliza } from '@elizaos/core';

const eliza = new Eliza();
eliza.registerPlugin(sunoPlugin);
```

## Example Usage

```typescript
// Basic music generation
await eliza.execute('suno.generate-music', {
  prompt: 'An upbeat electronic dance track with energetic beats',
  duration: 30,
  temperature: 1.0,
});

// Custom music generation
await eliza.execute('suno.custom-generate-music', {
  prompt: 'A melodic piano piece with soft strings',
  style: 'classical',
  bpm: 120,
  key: 'C',
  mode: 'major',
});

// Extend existing audio
await eliza.execute('suno.extend-audio', {
  audio_id: 'your-audio-id',
  duration: 60,
});
```

## Links

Original Plugin: https://github.com/gcui-art/suno-api?tab=readme-ov-file
