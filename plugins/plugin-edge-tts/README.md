# @elizaos/plugin-edge-tts

Free text-to-speech plugin for ElizaOS using Microsoft Edge TTS. No API key required.

## Features

- **Free**: No API key or payment required
- **High Quality**: Uses Microsoft's neural TTS voices (same as Edge browser)
- **Multiple Languages**: Supports 40+ languages with natural-sounding voices
- **Configurable**: Adjustable rate, pitch, and volume
- **OpenAI Compatible**: Maps OpenAI voice names (alloy, nova, etc.) to Edge TTS voices

## Installation

```bash
npm install @elizaos/plugin-edge-tts
```

## Usage

### As ElizaOS Plugin

```typescript
import { edgeTTSPlugin } from "@elizaos/plugin-edge-tts";

const runtime = new AgentRuntime({
  plugins: [edgeTTSPlugin],
  // ... other config
});

// Use via runtime
const audio = await runtime.useModel(ModelType.TEXT_TO_SPEECH, "Hello world!");
```

### Environment Variables

All configuration is optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `EDGE_TTS_VOICE` | `en-US-MichelleNeural` | Voice ID |
| `EDGE_TTS_LANG` | `en-US` | Language code |
| `EDGE_TTS_OUTPUT_FORMAT` | `audio-24khz-48kbitrate-mono-mp3` | Output format |
| `EDGE_TTS_RATE` | - | Rate adjustment (e.g., `+10%`, `-5%`) |
| `EDGE_TTS_PITCH` | - | Pitch adjustment (e.g., `+5Hz`, `-10Hz`) |
| `EDGE_TTS_VOLUME` | - | Volume adjustment (e.g., `+20%`, `-10%`) |
| `EDGE_TTS_PROXY` | - | HTTP proxy URL |
| `EDGE_TTS_TIMEOUT_MS` | `30000` | Request timeout |

## Popular Voices

### English (US)
- `en-US-MichelleNeural` - Female (default)
- `en-US-GuyNeural` - Male
- `en-US-JennyNeural` - Female
- `en-US-AriaNeural` - Female
- `en-US-DavisNeural` - Male
- `en-US-ChristopherNeural` - Male

### English (UK)
- `en-GB-SoniaNeural` - Female
- `en-GB-RyanNeural` - Male

### Other Languages
- `de-DE-KatjaNeural` - German Female
- `fr-FR-DeniseNeural` - French Female
- `es-ES-ElviraNeural` - Spanish Female
- `ja-JP-NanamiNeural` - Japanese Female
- `zh-CN-XiaoxiaoNeural` - Chinese Female
- `ko-KR-SunHiNeural` - Korean Female

## OpenAI Voice Mapping

For compatibility with OpenAI's TTS API, the following voice names are mapped:

| OpenAI Voice | Edge TTS Voice |
|--------------|----------------|
| `alloy` | `en-US-GuyNeural` |
| `echo` | `en-US-ChristopherNeural` |
| `fable` | `en-GB-RyanNeural` |
| `onyx` | `en-US-DavisNeural` |
| `nova` | `en-US-JennyNeural` |
| `shimmer` | `en-US-AriaNeural` |

## Browser Support

Edge TTS is **not available in browser environments** because it requires:
- Node.js file system access
- WebSocket connections that browsers don't support for this service

For browser TTS, use `@elizaos/plugin-elevenlabs` or `@elizaos/plugin-openai` instead.

## License

MIT
