# ElevenLabs Plugin

This plugin provides integration with ElevenLabs text-to-speech services through the ElizaOS platform.

## Usage

Add the plugin to your character configuration:

```json
"plugins": ["@elizaos/plugin-elevenlabs"]
```

## Configuration

The plugin requires these environment variables (can be set in .env file or character settings):

```json
"settings": {
  "ELEVENLABS_API_KEY": "your_elevenlabs_api_key",
  "ELEVENLABS_VOICE_ID": "EXAVITQu4vr4xnSDxMaL",
  "ELEVENLABS_MODEL_ID": "eleven_monolingual_v1",
  "ELEVENLABS_VOICE_STABILITY": "0.5",
  "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY": "0",
  "ELEVENLABS_OUTPUT_FORMAT": "pcm_16000",
  "ELEVENLABS_VOICE_SIMILARITY_BOOST": "0.75",
  "ELEVENLABS_VOICE_STYLE": "0",
  "ELEVENLABS_VOICE_USE_SPEAKER_BOOST": "true"
}
```

Or in `.env` file:

```
ELEVENLABS_API_KEY=your_elevenlabs_api_key
# Optional overrides:
ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL
ELEVENLABS_MODEL_ID=eleven_monolingual_v1
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=0
ELEVENLABS_OUTPUT_FORMAT=pcm_16000
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.75
ELEVENLABS_VOICE_STYLE=0
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=true
```

### Configuration Options

- `ELEVENLABS_API_KEY` (required): Your ElevenLabs API credentials.
- `ELEVENLABS_VOICE_ID`: Optional. Voice selection ID. Defaults to `EXAVITQu4vr4xnSDxMaL`.
- `ELEVENLABS_MODEL_ID`: Optional. Speech model ID. Defaults to `eleven_monolingual_v1`.
- `ELEVENLABS_VOICE_STABILITY`: Optional. Controls voice stability. Defaults to `0.5`.
- `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY`: Optional. Adjusts streaming latency. Defaults to `0`.
- `ELEVENLABS_OUTPUT_FORMAT`: Optional. Output format (e.g., pcm_16000). Defaults to `pcm_16000`.
- `ELEVENLABS_VOICE_SIMILARITY_BOOST`: Optional. Adjusts similarity to the reference voice (0-1). Defaults to `0.75`.
- `ELEVENLABS_VOICE_STYLE`: Optional. Controls voice style intensity (0-1). Defaults to `0`.
- `ELEVENLABS_VOICE_USE_SPEAKER_BOOST`: Optional. Enhances speaker presence (true/false). Defaults to `true`.
- `ELEVENLABS_STT_MODEL_ID`: Optional. Speech-to-text model ID. Defaults to `scribe_v1`.
- `ELEVENLABS_STT_LANGUAGE_CODE`: Optional. Language code for transcription (e.g., 'en', 'es'). Leave empty for automatic detection.
- `ELEVENLABS_STT_TIMESTAMPS_GRANULARITY`: Optional. Timestamp detail level: 'none', 'word', or 'character'. Defaults to `word`.
- `ELEVENLABS_STT_DIARIZE`: Optional. Enable speaker diarization (true/false). Defaults to `false`.
- `ELEVENLABS_STT_NUM_SPEAKERS`: Optional. Expected number of speakers for diarization (1-32).
- `ELEVENLABS_STT_TAG_AUDIO_EVENTS`: Optional. Tag audio events like laughter, applause (true/false). Defaults to `false`.

The plugin provides the following model types:

- `TEXT_TO_SPEECH`: Converts text into spoken audio.
- `TRANSCRIPTION`: Converts audio/video into text transcripts.
