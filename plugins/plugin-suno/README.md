# @elizaos/plugin-suno

Suno AI music generation plugin for elizaOS. Enables Eliza agents to generate, custom-generate, and extend audio tracks via the Suno API.

## What it does

This plugin contributes a Suno HTTP client and a status provider (`SUNO_STATUS`) to the elizaOS agent runtime. Music generation is dispatched through the `MUSIC` umbrella action (provided by `@elizaos/plugin-music`); this plugin supplies the Suno-specific handler (`sunoGenerateMusicHandler`) that `plugin-music` mounts.

Three subactions are supported:

| Subaction | Endpoint | Required params |
|---|---|---|
| `generate` | `POST /generate` | `prompt` |
| `custom_generate` | `POST /custom-generate` | `prompt`; optional: `style`, `bpm`, `key`, `mode`, `reference_audio` |
| `extend` | `POST /extend` | `audio_id`, `duration` |

The subaction is inferred from message text and params when not specified explicitly.

## Requirements

- A Suno API key (obtain at [suno.ai](https://suno.ai)).
- `@elizaos/plugin-music` loaded alongside this plugin to expose the `MUSIC` action to agents.

## Configuration

Set the API key as an environment variable or in the agent character config:

```
SUNO_API_KEY=your-suno-api-key
```

The plugin auto-enables when `SUNO_API_KEY` is present, or when agent config sets:

```json
{
  "media": {
    "audio": {
      "provider": "suno",
      "mode": "own-key"
    }
  }
}
```

## Generation parameters

### `generate` and `custom_generate`

| Param | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | (required) | Text description of the music to generate |
| `duration` | number | 30 | Duration in seconds |
| `temperature` | number | 1.0 | Randomness (higher = more creative) |
| `topK` | number | 250 | Top-K sampling |
| `topP` | number | 0.95 | Top-P sampling |
| `classifier_free_guidance` | number | 3.0 | Prompt adherence strength |
| `style` | string | — | Musical style (custom_generate only) |
| `bpm` | number | — | Beats per minute (custom_generate only) |
| `key` | string | — | Musical key, e.g. `"C"` (custom_generate only) |
| `mode` | string | — | `"major"` or `"minor"` (custom_generate only) |
| `reference_audio` | string | — | Reference audio path (custom_generate only) |

### `extend`

| Param | Type | Required | Description |
|---|---|---|---|
| `audio_id` | string | Yes | ID of the existing track to extend |
| `duration` | number | Yes | Additional seconds to add |

## Response shape

```ts
interface GenerationResponse {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  audio_url?: string;
  error?: string;
}
```

Responses larger than 4000 bytes are truncated before being returned to the agent context.
