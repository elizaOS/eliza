---
title: Media Generation
sidebarTitle: Media Generation
description: Generate images, videos, and audio, or analyze images using AI providers like FAL, OpenAI, Google, xAI, and Eliza Cloud.
---

Eliza includes a media generation abstraction layer that provides a unified interface for creating images, videos, and audio, as well as analyzing images with AI vision. Multiple provider backends are supported, with Eliza Cloud as the default (no API key required).

## Architecture Overview

The media system is organized into three components:

1. **Provider abstraction** (`src/providers/media-provider.ts`) -- Defines unified interfaces (`ImageGenerationProvider`, `VideoGenerationProvider`, `AudioGenerationProvider`, `VisionAnalysisProvider`) and concrete implementations for each backend. A factory function for each media type selects the appropriate provider based on your configuration.
2. **Actions** (`src/actions/media.ts`) -- Two built-in agent actions (`GENERATE_MEDIA`, `ANALYZE_IMAGE`) that expose media capabilities to the agent during conversations. `GENERATE_MEDIA` handles image, video, and audio generation; `ANALYZE_IMAGE` handles vision analysis. Each action reads the current `eliza.json` configuration, instantiates the correct provider, and returns results as message attachments.
3. **Configuration** (`eliza.json`) -- The `media` section controls which provider is used for each media type, whether to use Eliza Cloud or your own API keys, and provider-specific settings like model names and base URLs.

```
User message: "Draw me a sunset over mountains"
       |
       v
  Agent selects GENERATE_MEDIA action
       |
       v
  loadElizaConfig() -> reads media.image settings
       |
       v
  createImageProvider() -> selects provider (e.g., FAL, OpenAI, or Cloud)
       |
       v
  provider.generate({ prompt: "a sunset over mountains" })
       |
       v
  Returns image URL or base64 -> attached to agent response
```

## Media Capabilities

### Image Generation

Generate images from text prompts with control over size, quality, and style.

**Supported providers:**

| Provider | Config Key | Default Model | API Endpoint |
|----------|-----------|--------------|-------------|
| Eliza Cloud | `cloud` (default) | Managed | `{cloudBaseUrl}/media/image/generate` |
| FAL.ai | `fal` | `fal-ai/flux-pro` | `https://fal.run/{model}` |
| OpenAI | `openai` | `dall-e-3` | `https://api.openai.com/v1/images/generations` |
| Google | `google` | `imagen-3.0-generate-002` | Google Generative Language API |
| xAI | `xai` | `grok-2-image` | `https://api.x.ai/v1/images/generations` |

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the image to generate |
| `size` | string | No | Image dimensions (e.g., `1024x1024`, `1792x1024`). FAL uses named sizes like `landscape_4_3` |
| `quality` | string | No | `standard` or `hd` (OpenAI only) |
| `style` | string | No | `natural` or `vivid` (OpenAI only) |
| `negativePrompt` | string | No | Things to avoid in the generated image (FAL only) |
| `seed` | number | No | Reproducibility seed (FAL only) |

**Output:** Returns an `imageUrl` (URL to the generated image) or `imageBase64` (base64-encoded image data), plus an optional `revisedPrompt` showing how the provider interpreted your prompt (OpenAI and xAI).

### Video Generation

Generate videos from text prompts, optionally using an input image as the starting frame.

**Supported providers:**

| Provider | Config Key | Default Model | API Endpoint |
|----------|-----------|--------------|-------------|
| Eliza Cloud | `cloud` (default) | Managed | `{cloudBaseUrl}/media/video/generate` |
| FAL.ai | `fal` | `fal-ai/minimax-video` | `https://fal.run/{model}` |
| OpenAI | `openai` | `sora-1.0-turbo` | `https://api.openai.com/v1/videos/generations` |
| Google | `google` | `veo-2.0-generate-001` | Google Generative Language API (long-running operation) |

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the video to generate |
| `duration` | number | No | Video duration in seconds (OpenAI defaults to 5) |
| `aspectRatio` | string | No | Aspect ratio (e.g., `16:9`, `9:16`, `1:1`). Defaults to `16:9` |
| `imageUrl` | string | No | URL of an image to use as starting frame (image-to-video) |

**Output:** Returns a `videoUrl`, optional `thumbnailUrl`, and optional `duration` in seconds. Google Veo uses a long-running operation model -- if the video is not ready immediately, the response contains a pending operation reference that should be polled.

### Audio Generation

Generate music, songs, or sound effects from text prompts.

**Supported providers:**

| Provider | Config Key | Default Model | API Endpoint |
|----------|-----------|--------------|-------------|
| Eliza Cloud | `cloud` (default) | Managed | `{cloudBaseUrl}/media/audio/generate` |
| Suno | `suno` | `chirp-v3.5` | `https://api.suno.ai/v1/generate` |

The provider module header also references ElevenLabs for sound effects (`ElevenLabs SFX`), with configuration type `AudioElevenlabsSfxConfig` accepting an `apiKey` and optional `duration`.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | Yes | Text description of the audio (lyrics, mood, style, etc.) |
| `duration` | number | No | Audio duration in seconds |
| `instrumental` | boolean | No | Whether to generate instrumental music without vocals |
| `genre` | string | No | Music genre (e.g., `pop`, `rock`, `classical`, `synthwave`) |

**Output:** Returns an `audioUrl`, optional `title`, and optional `duration` in seconds.

### Image Analysis (Vision)

Analyze images to describe contents, identify objects, read text, or answer questions about visual content.

**Supported providers:**

| Provider | Config Key | Default Model | API Endpoint |
|----------|-----------|--------------|-------------|
| Eliza Cloud | `cloud` (default) | Managed | `{cloudBaseUrl}/media/vision/analyze` |
| OpenAI | `openai` | `gpt-5` | `https://api.openai.com/v1/chat/completions` |
| Google | `google` | `gemini-2.5-flash` | Google Generative Language API |
| Anthropic | `anthropic` | `claude-sonnet-4-6` | `https://api.anthropic.com/v1/messages` |
| xAI | `xai` | `grok-2-vision-1212` | `https://api.x.ai/v1/chat/completions` |
| Ollama | `ollama` | `llava` | `http://localhost:11434/api/chat` |

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `imageUrl` | string | No* | URL of the image to analyze |
| `imageBase64` | string | No* | Base64-encoded image data (alternative to URL) |
| `prompt` | string | No | Specific question or instruction (default: "Describe this image in detail.") |
| `maxTokens` | number | No | Maximum tokens for the response (default: 1024) |

*At least one of `imageUrl` or `imageBase64` must be provided.

**Output:** Returns a `description` (text), optional `labels` (array of identified items), and optional `confidence` score.

#### Ollama Local Vision

The Ollama provider runs entirely locally, requiring no API key. It includes automatic model management:

- On first use, the provider checks whether the configured model (default: `llava`) is available on your Ollama instance.
- If the model is not found and `autoDownload` is enabled (the default), it automatically pulls the model.
- If `autoDownload` is disabled and the model is missing, the provider returns an error message suggesting you run `ollama pull {model}`.
- Images provided by URL are automatically fetched and converted to base64 before sending to Ollama, since Ollama's vision API requires base64-encoded image data.

## Actions

Two built-in actions expose media generation and analysis to the agent. Each action validates its parameters, instantiates the appropriate provider from the current configuration, and returns results with message attachments.

### GENERATE_MEDIA

**Triggers:** `CREATE_IMAGE`, `MAKE_IMAGE`, `DRAW`, `PAINT`, `ILLUSTRATE`, `RENDER_IMAGE`, `IMAGE_GEN`, `TEXT_TO_IMAGE`, `CREATE_VIDEO`, `MAKE_VIDEO`, `ANIMATE`, `RENDER_VIDEO`, `VIDEO_GEN`, `TEXT_TO_VIDEO`, `FILM`, `CREATE_AUDIO`, `MAKE_MUSIC`, `COMPOSE`, `GENERATE_MUSIC`, `CREATE_SONG`, `MAKE_SOUND`, `AUDIO_GEN`, `TEXT_TO_MUSIC`

Generates image, video, or audio media from a text prompt. Set `mediaType` to `image`, `video`, or `audio` when providing explicit parameters; otherwise the agent infers the media type from the user request.

For image generation, if a `revisedPrompt` is returned by the provider (OpenAI and xAI do this), the response text includes it. The generated image is returned as an attachment with MIME type `image/png`.

**Example conversation:**

> User: "Draw me a cyberpunk cityscape at night"
>
> Agent: "Here's the generated image based on: 'A detailed cyberpunk cityscape at night with neon lights...'"
> [image attachment]

For video generation, optionally provide an `imageUrl` parameter for image-to-video generation, where the provided image becomes the first frame. The video is returned as an attachment with MIME type `video/mp4`.

For audio generation, `GENERATE_MEDIA` supports creating songs with lyrics, instrumental tracks, or sound effects. The response includes the generated title when available. The audio is returned as an attachment with MIME type `audio/mpeg`.

### ANALYZE_IMAGE

**Triggers:** `DESCRIBE_IMAGE`, `WHAT_IS_IN_IMAGE`, `IDENTIFY_IMAGE`, `READ_IMAGE`, `UNDERSTAND_IMAGE`, `VISION`, `OCR`, `IMAGE_TO_TEXT`

Analyzes an image using AI vision. Accepts either an image URL or base64-encoded data. Returns a text description directly as the response text, with optional labels and confidence scores in the response data.

## Configuration

Media providers are configured in the `media` section of `eliza.json`. Each media type (image, video, audio, vision) is configured independently, so you can use different providers for different capabilities.

```json
{
  "media": {
    "image": {
      "mode": "own-key",
      "provider": "fal",
      "fal": {
        "apiKey": "your-fal-api-key",
        "model": "fal-ai/flux-pro",
        "baseUrl": "https://fal.run"
      }
    },
    "video": {
      "mode": "cloud",
      "provider": "cloud"
    },
    "audio": {
      "mode": "own-key",
      "provider": "suno",
      "suno": {
        "apiKey": "your-suno-api-key"
      }
    },
    "vision": {
      "mode": "own-key",
      "provider": "openai",
      "openai": {
        "apiKey": "your-openai-api-key",
        "model": "gpt-5"
      }
    }
  }
}
```

### Mode Selection

Each media type supports two modes:

| Mode | Description |
|------|-------------|
| `cloud` | Uses Eliza Cloud as a proxy (default). No API key needed from the user. |
| `own-key` | Uses the user's own API key with their chosen provider. |

When `mode` is `cloud` (or unset), the system always routes to Eliza Cloud regardless of the `provider` field. When `mode` is `own-key`, the system uses the specified `provider` and its corresponding configuration block.

If the selected provider's API key is missing or the provider is not recognized, the system falls back to Eliza Cloud automatically. This fallback behavior means your agent always has media capabilities even if a provider is misconfigured.

### Eliza Cloud Configuration

Eliza Cloud settings are in the `cloud` section of `eliza.json`:

```json
{
  "cloud": {
    "baseUrl": "https://elizacloud.ai/api/v1",
    "apiKey": "optional-cloud-api-key"
  }
}
```

The default base URL is `https://elizacloud.ai/api/v1`. The API key is optional and can provide access to higher-tier cloud features. When provided, it is sent as a `Bearer` token in the `Authorization` header.

Eliza Cloud exposes four media endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /media/image/generate` | Image generation |
| `POST /media/video/generate` | Video generation |
| `POST /media/audio/generate` | Audio generation |
| `POST /media/vision/analyze` | Image analysis |

### Provider-Specific API Keys

Each provider requires its own API key when using `own-key` mode:

- **FAL.ai**: `media.image.fal.apiKey` or `media.video.fal.apiKey` -- sent as `Authorization: Key {apiKey}`
- **OpenAI**: `media.image.openai.apiKey`, `media.video.openai.apiKey`, or `media.vision.openai.apiKey` -- sent as `Authorization: Bearer {apiKey}`
- **Google**: `media.image.google.apiKey`, `media.video.google.apiKey`, or `media.vision.google.apiKey` -- sent as a `key` query parameter
- **xAI**: `media.image.xai.apiKey` or `media.vision.xai.apiKey` -- sent as `Authorization: Bearer {apiKey}`
- **Anthropic**: `media.vision.anthropic.apiKey` -- sent as `x-api-key` header
- **Suno**: `media.audio.suno.apiKey` -- sent as `Authorization: Bearer {apiKey}`
- **Ollama** (vision only): No API key required, just a base URL (`media.vision.ollama.baseUrl`, defaults to `http://localhost:11434`)

## Provider-Specific Configuration Reference

### FAL.ai

```json
{
  "media": {
    "image": {
      "mode": "own-key",
      "provider": "fal",
      "fal": {
        "apiKey": "your-fal-api-key",
        "model": "fal-ai/flux-pro",
        "baseUrl": "https://fal.run"
      }
    },
    "video": {
      "mode": "own-key",
      "provider": "fal",
      "fal": {
        "apiKey": "your-fal-api-key",
        "model": "fal-ai/minimax-video",
        "baseUrl": "https://fal.run"
      }
    }
  }
}
```

FAL supports both image and video generation. The `model` field specifies which FAL model to use -- you can swap in any supported model from the FAL model catalog. The `baseUrl` defaults to `https://fal.run` and typically does not need to be changed.

### OpenAI

```json
{
  "media": {
    "image": {
      "mode": "own-key",
      "provider": "openai",
      "openai": {
        "apiKey": "your-openai-api-key",
        "model": "dall-e-3",
        "quality": "standard",
        "style": "vivid"
      }
    },
    "video": {
      "mode": "own-key",
      "provider": "openai",
      "openai": {
        "apiKey": "your-openai-api-key",
        "model": "sora-1.0-turbo"
      }
    },
    "vision": {
      "mode": "own-key",
      "provider": "openai",
      "openai": {
        "apiKey": "your-openai-api-key",
        "model": "gpt-5",
        "maxTokens": 1024
      }
    }
  }
}
```

OpenAI supports image generation (DALL-E), video generation (Sora), and vision analysis (GPT-4o). The image provider accepts `quality` (`standard` or `hd`) and `style` (`natural` or `vivid`) defaults that apply when the action does not specify them.

### Google

```json
{
  "media": {
    "image": {
      "mode": "own-key",
      "provider": "google",
      "google": {
        "apiKey": "your-google-api-key",
        "model": "imagen-3.0-generate-002",
        "aspectRatio": "1:1"
      }
    },
    "video": {
      "mode": "own-key",
      "provider": "google",
      "google": {
        "apiKey": "your-google-api-key",
        "model": "veo-2.0-generate-001"
      }
    },
    "vision": {
      "mode": "own-key",
      "provider": "google",
      "google": {
        "apiKey": "your-google-api-key",
        "model": "gemini-2.5-flash"
      }
    }
  }
}
```

Google supports image generation (Imagen), video generation (Veo), and vision analysis (Gemini). The Imagen provider defaults to `aspectRatio: "1:1"` and enables `personGeneration: "allow_adult"` with `safetyFilterLevel: "block_few"`. Veo uses a long-running operation endpoint that may require polling for completion.

### Anthropic

```json
{
  "media": {
    "vision": {
      "mode": "own-key",
      "provider": "anthropic",
      "anthropic": {
        "apiKey": "your-anthropic-api-key",
        "model": "claude-sonnet-4-6"
      }
    }
  }
}
```

Anthropic is available for vision only. It uses the Claude Messages API with `anthropic-version: 2023-06-01`. Images can be provided as base64 data or URLs.

### xAI

```json
{
  "media": {
    "image": {
      "mode": "own-key",
      "provider": "xai",
      "xai": {
        "apiKey": "your-xai-api-key",
        "model": "grok-2-image"
      }
    },
    "vision": {
      "mode": "own-key",
      "provider": "xai",
      "xai": {
        "apiKey": "your-xai-api-key",
        "model": "grok-2-vision-1212"
      }
    }
  }
}
```

xAI supports image generation and vision analysis. Both use OpenAI-compatible API formats, making the integration straightforward.

### Ollama (Local Vision)

```json
{
  "media": {
    "vision": {
      "mode": "own-key",
      "provider": "ollama",
      "ollama": {
        "baseUrl": "http://localhost:11434",
        "model": "llava",
        "maxTokens": 1024,
        "autoDownload": true
      }
    }
  }
}
```

Ollama runs locally and requires no API key. Set `autoDownload` to `false` if you prefer to manage models manually with `ollama pull`.

## Output Formats and Storage

Media generation results are returned as message attachments:

| Media Type | MIME Type | Delivery |
|-----------|-----------|----------|
| Image | `image/png` | URL or base64 data |
| Video | `video/mp4` | URL |
| Audio | `audio/mpeg` | URL |

- **URLs** are typically temporary and hosted by the provider. Eliza Cloud, FAL, and other providers return time-limited URLs that may expire.
- **Base64 data** is returned inline for providers that do not provide a URL (e.g., Google Imagen returns base64-encoded image data).

Each attachment includes a `type` field (`image`, `video`, or `audio`) and the relevant `url` or `base64` field.

## Troubleshooting

### Provider Falls Back to Eliza Cloud

If you configure `mode: "own-key"` but the system uses Eliza Cloud anyway, check:

1. The `provider` field matches a supported provider name (`fal`, `openai`, `google`, `xai`, `anthropic`, `suno`, `ollama`).
2. The provider's configuration block exists and contains a valid `apiKey`.
3. The configuration block is nested under the correct media type (e.g., `media.image.fal`, not `media.fal`).

The factory function checks `mode` first -- if it is `"cloud"` or unset, it always returns the Eliza Cloud provider regardless of other settings.

### "I need a prompt to generate..." Errors

The agent actions require a `prompt` parameter. If the agent responds with "I need a prompt to generate an image," it means the LLM did not extract a prompt from the user's message. Try being more explicit in your request.

### Ollama Vision Errors

- **"Ollama server not reachable"** -- Ensure Ollama is running (`ollama serve`) and accessible at the configured `baseUrl`.
- **"Model not found"** -- Either enable `autoDownload` or manually pull the model with `ollama pull llava`.
- **Slow first request** -- If `autoDownload` is enabled and the model has not been downloaded yet, the first request will download the model (which can be several gigabytes) before processing.

### Google Veo Pending Operations

Google Veo video generation uses a long-running operation model. If the video is not ready immediately, the response includes a `videoUrl` prefixed with `pending:` followed by the operation name. In production, you would poll the Google operation endpoint until the video is ready.

## Media Provider Runbook

### Setup Checklist

1. Set `media.<type>.mode` and `media.<type>.provider` for each enabled media type (`image`, `video`, `audio`, `vision`).
2. Provide provider credentials for every `own-key` integration — keys must be nested under the correct media-type path (e.g., `media.image.fal.apiKey`, not `media.fal.apiKey`).
3. For Ollama vision, verify the server is running (`ollama serve`) and the model is available or `autoDownload` is enabled.
4. Confirm Eliza Cloud fallback behavior is acceptable — if an `own-key` provider's API key is missing or unrecognized, the factory silently falls back to Eliza Cloud.
5. Verify network connectivity to provider endpoints; for Google Veo, confirm your API key has access to the long-running operations API.

### Failure Modes

**Provider authentication and selection:**

- `Eliza Cloud error: <status>`:
  Cloud proxy rejected the request. Verify `cloud.baseUrl` is reachable and `cloud.apiKey` (if set) is valid.
- Silent fallback to Eliza Cloud when `own-key` is intended:
  The factory returns the Cloud provider whenever the API key is missing for the selected provider. Confirm the key is present at `media.<type>.<provider>.apiKey`.
- `FAL error` / `OpenAI error` / `Google Imagen error` / `xAI error` / `Suno error`:
  Provider returned a non-OK response. Check API key validity, account quota, and model availability.

**Generation failures:**

- `No image returned from <provider>` / `No video returned` / `No description returned`:
  Provider returned HTTP 200 but the response payload was empty. This typically indicates a model or parameter mismatch — verify the `model` field is a valid model ID for that provider.
- Google Veo pending operations:
  Veo returns a `pending:<operation-name>` URL when generation is not instant. The operation must be polled to completion — if the agent does not poll, the video URL is unusable.
- Generation timeouts:
  Check provider latency and retry policy. FAL and Suno can have long generation times for complex prompts; avoid aggressive client-side timeouts.

**Ollama-specific failures:**

- `Ollama server not reachable`:
  Ollama is not running or the configured `baseUrl` is wrong. Start with `ollama serve`.
- `Model not found` / `Failed to download model`:
  The model is not available locally. Enable `autoDownload` or manually run `ollama pull <model>`.
- `Failed to fetch image`:
  When analyzing a URL-based image, the provider fetches and converts it to base64. Network errors or invalid URLs cause this failure.

### Recovery Procedures

1. **Provider credential rotation:** Update the API key in `eliza.json` under `media.<type>.<provider>.apiKey` and restart the agent. No cache or state needs clearing — provider instances are created fresh per request.
2. **Stuck on Eliza Cloud fallback:** If the agent unexpectedly uses Cloud instead of your own-key provider, check: (a) `mode` is `"own-key"`, (b) `provider` is a recognized name, and (c) the API key is at the correct nested path. Fix the config and restart.
3. **Ollama model corruption:** Delete the model with `ollama rm <model>` and re-pull with `ollama pull <model>`. Ensure `autoDownload: true` is set to prevent future missing-model errors.

### Verification Commands

```bash
# Media action and provider unit tests
bunx vitest run src/actions/__tests__/media.test.ts src/providers/media-provider.test.ts

# Type-check media provider and action code
bun run typecheck
```
