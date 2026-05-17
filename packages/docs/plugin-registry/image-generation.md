---
title: "Image Generation Plugin"
sidebarTitle: "Image Generation"
description: "Image generation plugin for Eliza — DALL-E, Stable Diffusion, FAL, and other image models."
---

<Warning>
This plugin is not yet available in the Eliza plugin registry. For image generation, use providers that support it natively (OpenAI DALL-E, Google Imagen) through their respective provider plugins.
</Warning>

The Image Generation plugin enables Eliza agents to generate images using AI image models, including OpenAI's DALL-E, Stable Diffusion via FAL, and other providers.

> **On-demand plugin.** This plugin is resolved from the remote elizaOS plugin registry and auto-installs when configured. It is not included in Eliza's bundled `plugins.json` index.

**Package:** `@elizaos/plugin-image-generation`

## Overview

The Image Generation plugin registers an `IMAGE` model handler and a set of actions that allow agents to generate images from text descriptions, edit existing images, and create variations.

## Installation

```bash
eliza plugins install @elizaos/plugin-image-generation
```

## Enable via Features

```json
{
  "features": {
    "imageGen": true
  }
}
```

## Configuration

The plugin supports multiple image generation backends. Configure via the `media.image` section:

```json
{
  "media": {
    "image": {
      "enabled": true,
      "mode": "own-key",
      "provider": "openai",
      "model": "dall-e-3"
    }
  }
}
```

### OpenAI DALL-E

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |

```json
{
  "media": {
    "image": {
      "provider": "openai",
      "model": "dall-e-3",
      "size": "1024x1024",
      "quality": "standard"
    }
  }
}
```

### FAL (Stable Diffusion and others)

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `FAL_API_KEY` | Yes | FAL API key from [fal.ai](https://fal.ai) |

```json
{
  "media": {
    "image": {
      "provider": "fal",
      "model": "fal-ai/flux/schnell"
    }
  }
}
```

## Supported Providers and Models

### OpenAI

| Model | Description |
|-------|-------------|
| `dall-e-3` | Highest quality, 1024×1024 to 1792×1024 |
| `dall-e-2` | Legacy, 256×256 to 1024×1024 |

### FAL

| Model ID | Description |
|---------|-------------|
| `fal-ai/flux/schnell` | FLUX Schnell — fast, high quality |
| `fal-ai/flux/dev` | FLUX Dev — more detailed |
| `fal-ai/flux-pro` | FLUX Pro — best quality |
| `fal-ai/stable-diffusion-v3-medium` | SD3 Medium |
| `fal-ai/stable-video-diffusion` | Video generation |

## Actions

| Action | Description |
|--------|-------------|
| `GENERATE_MEDIA` | Generate an image from a text description using `mediaType: "image"` |
| `EDIT_IMAGE` | Edit an existing image with a prompt |
| `IMAGE_VARIATION` | Create variations of an existing image |
| `DESCRIBE_IMAGE` | Analyze and describe an image (uses vision) |

## Usage Examples

After the plugin is loaded:

> "Draw a cozy coffee shop on a rainy afternoon, watercolor style"

> "Generate an image of a robot reading a book in a library"

> "Create a logo for an AI company called Eliza"

The agent generates the image and can share it in the conversation or save it to the workspace.

## Output Handling

Generated images are:

- Returned as URLs (hosted temporarily by the provider)
- Optionally downloaded and saved to the agent workspace
- Embeddable in supported platform connectors (Discord, Telegram)

## Size and Quality Options

### DALL-E 3 Sizes

| Size | Aspect Ratio |
|------|-------------|
| `1024x1024` | Square (default) |
| `1792x1024` | Landscape |
| `1024x1792` | Portrait |

### DALL-E 3 Quality

| Quality | Description |
|---------|-------------|
| `standard` | Faster, lower cost |
| `hd` | Higher detail, slower, higher cost |

## Media Configuration

For FAL auto-enable, set in `media.image`:

```json
{
  "media": {
    "image": {
      "enabled": true,
      "mode": "own-key",
      "provider": "fal"
    }
  }
}
```

This triggers the FAL plugin to load automatically.

## Related

- [TTS Plugin](/plugin-registry/tts) — Text-to-speech generation
- [Browser Plugin](/plugin-registry/browser) — Web screenshots
- [Media Generation Guide](/guides/media-generation) — Full media generation guide
