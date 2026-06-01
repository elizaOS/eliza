# @elizaos/plugin-elevenlabs

Adds ElevenLabs-powered text-to-speech (TTS) and speech-to-text (STT) capabilities to Eliza agents.

## What this plugin does

- **TTS (`ModelType.TEXT_TO_SPEECH`):** Converts text to spoken audio using ElevenLabs voices. Returns a `Uint8Array` of audio data. Supports multiple voice models, configurable voice settings, and per-call format/voice overrides.
- **STT (`ModelType.TRANSCRIPTION`):** Transcribes audio to text using ElevenLabs Scribe. Accepts a URL, `Buffer`, or `{ audioUrl }` object. Supports speaker diarization (up to 32 speakers), language auto-detection, and audio event tagging.

## Enable the plugin

Add to your character's `plugins` list:

```json
"plugins": ["@elizaos/plugin-elevenlabs"]
```

## Required configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ELEVENLABS_API_KEY` | **Yes** | ElevenLabs API key |

## Optional TTS configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ELEVENLABS_VOICE_ID` | `EXAVITQu4vr4xnSDxMaL` | Voice ID |
| `ELEVENLABS_MODEL_ID` | `eleven_monolingual_v1` | TTS model |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_44100_128` | Audio format (ElevenLabs enum); use `mp3_44100_128` for browser compatibility |
| `ELEVENLABS_VOICE_STABILITY` | `0.5` | 0–1; higher = more consistent |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | `0.75` | 0–1; higher = closer to reference voice |
| `ELEVENLABS_VOICE_STYLE` | `0` | 0–1; style intensity |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | `true` | Enable speaker boost |
| `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY` | `0` | 0–4; higher reduces latency at quality cost |
| `ELEVENLABS_BROWSER_URL` | — | Proxy base URL for browser builds; the proxy injects the API key server-side |

## Optional STT configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ELEVENLABS_STT_MODEL_ID` | `scribe_v1` | STT model |
| `ELEVENLABS_STT_LANGUAGE_CODE` | _(auto-detect)_ | e.g. `en`, `es`; leave unset for auto |
| `ELEVENLABS_STT_TIMESTAMPS_GRANULARITY` | `word` | `none`, `word`, or `character` |
| `ELEVENLABS_STT_DIARIZE` | `false` | Enable speaker diarization |
| `ELEVENLABS_STT_NUM_SPEAKERS` | — | Expected speaker count (1–32); used when diarize=true |
| `ELEVENLABS_STT_TAG_AUDIO_EVENTS` | `false` | Tag laughter, applause, etc. |

## Example character settings

```json
{
  "plugins": ["@elizaos/plugin-elevenlabs"],
  "settings": {
    "ELEVENLABS_API_KEY": "your_api_key",
    "ELEVENLABS_VOICE_ID": "EXAVITQu4vr4xnSDxMaL",
    "ELEVENLABS_MODEL_ID": "eleven_monolingual_v1",
    "ELEVENLABS_OUTPUT_FORMAT": "mp3_44100_128"
  }
}
```

Or via `.env`:

```
ELEVENLABS_API_KEY=your_api_key
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_MODEL_ID=eleven_monolingual_v1
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
```
