# @elizaos/plugin-streaming

Unified RTMP live streaming for Eliza agents. Supports Twitch, YouTube Live, X (Twitter), pump.fun, and custom or named RTMP ingest URLs.

## What it does

- Adds a `STREAM` agent action so the agent can start/stop streams and check live status in response to natural-language requests ("go live on Twitch", "stop the YouTube stream", "is the X stream live?").
- Manages a local FFmpeg pipeline: screen/window capture, audio mixing, RTMP push.
- Supports Eliza Cloud relay mode: the cloud fans one inbound stream to N platform destinations using stored credentials.
- Provides a `streamStatus` context provider so the agent always knows which streams are live.
- Handles TTS-to-stream audio: agent speech is generated and piped directly into FFmpeg's audio track.

## Capabilities added

| Capability | Details |
|---|---|
| `STREAM` action | `start`, `stop`, `status` for twitch / youtube / x / pumpfun |
| `streamStatus` provider | Per-turn JSON snapshot of all platform stream states |
| Video capture | pipe (desktop UI), avfoundation (macOS), x11grab (Linux/Xvfb), file (headless browser), testsrc |
| Audio sources | silent, system, microphone, tts (ElevenLabs / OpenAI / Edge / local inference), audio file |
| Overlay layouts | Per-destination JSON widget layout; seeded from plugin defaults on first start |
| Stream settings | Visual settings (theme, avatarIndex, voice) persisted in `data/stream/` |
| Cloud relay | Push to Eliza Cloud ingest; cloud relays to platform RTMP endpoints |

## Requirements

- **FFmpeg** must be installed and on `PATH`. The plugin throws with install instructions if not found.
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
- For TTS audio on streams: ElevenLabs, OpenAI, or Edge TTS API credentials (or a local inference model).
- For Eliza Cloud relay: `ELIZAOS_CLOUD_API_KEY` and cloud connection.

## Enabling the plugin

The plugin activates automatically when any streaming destination is configured. Add to your agent config under the `streaming` key:

```json
{
  "streaming": {
    "twitch": { "streamKey": "live_..." },
    "youtube": { "streamKey": "xxxx-xxxx-xxxx-xxxx" },
    "customRtmp": { "rtmpUrl": "rtmp://ingest.example.com/live", "rtmpKey": "my-key" },
    "rtmpSources": [
      { "id": "my-server", "name": "My Server", "rtmpUrl": "rtmp://...", "rtmpKey": "..." }
    ]
  }
}
```

Or via environment variables (all optional; any one enables the plugin):

| Env var | Purpose |
|---|---|
| `TWITCH_STREAM_KEY` | Twitch RTMP stream key |
| `YOUTUBE_STREAM_KEY` | YouTube Live stream key |
| `YOUTUBE_RTMP_URL` | Override YouTube ingest URL |
| `X_STREAM_KEY` | X (Twitter) stream key |
| `X_RTMP_URL` | X RTMP ingest URL |
| `PUMPFUN_STREAM_KEY` | pump.fun stream key |
| `PUMPFUN_RTMP_URL` | pump.fun RTMP ingest URL |
| `CUSTOM_RTMP_URL` | Custom ingest URL |
| `CUSTOM_RTMP_KEY` | Custom stream key |

## Cloud relay vs. direct push

Set `<PLATFORM>_STREAMING_BACKEND` to control backend selection:

- `direct` — push to the platform's RTMP ingest using a local stream key (default when a key is set).
- `cloud` — request a per-session relay from Eliza Cloud; requires `ELIZAOS_CLOUD_API_KEY`.
- `auto` (default) — picks `cloud` when Eliza Cloud is connected and no local key is set; otherwise `direct`.

## Stream key setup

Stream keys come from each platform's studio or dashboard — there is no OAuth in this package.

- Twitch: https://dashboard.twitch.tv/u/YOUR_USERNAME/settings/stream
- YouTube: https://studio.youtube.com → Go Live → Stream settings
- X (Twitter): https://studio.twitter.com → Go Live
- pump.fun: platform stream dashboard

## Preset destination factories

```ts
import {
  createTwitchDestination,
  createYoutubeDestination,
  createXStreamDestination,
  createPumpfunDestination,
  createCustomRtmpDestination,
  createNamedRtmpDestination,
} from "@elizaos/plugin-streaming";
```

Pass a factory result to the streaming pipeline's destination map when constructing `StreamRouteState`.

## Default export

```ts
import streamingPlugin from "@elizaos/plugin-streaming";
// or
import { streamingPlugin } from "@elizaos/plugin-streaming";
```

`streamingPlugin` is the `Plugin` object to register with an elizaOS agent runtime.
