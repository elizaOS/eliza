---
title: "FAL Plugin"
sidebarTitle: "FAL"
description: "FAL media generation plugin for Eliza — access FAL.ai's suite of image, video, and audio generation models."
---

<Warning>
This plugin is not yet available in the Eliza plugin registry. FAL media generation is not currently supported as a standalone plugin.
</Warning>

The FAL plugin connects Eliza agents to [FAL.ai](https://fal.ai)'s media generation platform, providing access to fast inference for image, video, and audio generation models.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when its API key is detected. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-fal`

## Installation

```bash
eliza plugins install @elizaos/plugin-fal
```

## Configuration

### Enable via Features

```json
{
  "features": {
    "fal": true
  }
}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAL_KEY` | Yes | FAL.ai API key from [fal.ai/dashboard](https://fal.ai/dashboard) |

```bash
export FAL_KEY=your-fal-api-key
```

## Supported Capabilities

| Capability | Examples |
|-----------|----------|
| Image generation | Flux, Stable Diffusion, SDXL |
| Video generation | Runway, AnimateDiff |
| Audio generation | Text-to-speech, music |
| Image editing | Inpainting, upscaling, style transfer |

## Features

- Image generation via FAL.ai models (Flux, Stable Diffusion, etc.)
- Video generation
- Audio generation
- Fast inference on serverless GPU infrastructure
- Wide selection of open-source and commercial models

## Related

- [Image Generation Plugin](/plugin-registry/image-generation) — General image generation
- [Suno Plugin](/plugin-registry/suno) — Music generation
- [Media Generation Guide](/guides/media-generation) — Overview of media capabilities
