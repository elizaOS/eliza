---
title: Stream
sidebarTitle: Stream
description: Go live with your Eliza agent — stream to Twitch, YouTube, or any RTMP destination with overlays, voice, and real-time widgets.
---

The Stream tab lets you broadcast your agent live to streaming platforms. The `StreamView` component renders the stream canvas (1280x720), manages overlays, and provides controls for going live, adjusting volume, and switching destinations.

## Going Live

To start streaming, select a destination from the status bar and click the stream toggle button.

### Supported Destinations

| Destination | Plugin | Notes |
|-------------|--------|-------|
| **Twitch, YouTube, X, pump.fun, custom RTMP, named sources** | `@elizaos/plugin-streaming` | One plugin; configure `streaming.*` in settings |

Each destination provides RTMP URL and stream key credentials, optional lifecycle hooks (`onStreamStart`, `onStreamStop`), and per-destination default overlay layouts.

<Info>
Install **`@elizaos/plugin-streaming`** and configure stream keys under **streaming** in plugin/config settings (`twitch`, `youtube`, `x`, `pumpfun`, `customRtmp`, `rtmpSources`).
</Info>

### FFmpeg Requirement

Streaming requires FFmpeg to be installed on the host system. FFmpeg handles encoding and RTMP output.

| Platform | Install Command |
|----------|----------------|
| **macOS** | `brew install ffmpeg` |
| **Linux (Debian/Ubuntu)** | `sudo apt install ffmpeg` |
| **Windows** | Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH |

The runtime auto-detects the capture mode based on environment:

| Mode | Environment | Method |
|------|-------------|--------|
| **pipe** | Electrobun | UI frames captured via `capturePage()` and piped to FFmpeg stdin |
| **x11grab** | Linux | Xvfb virtual display capture |
| **avfoundation** | macOS | Native screen capture |
| **file** | Headless | Puppeteer CDP screenshots piped to FFmpeg |

All modes output 1280x720 at 15-30 fps with 1500k bitrate.

## Overlay System

The stream canvas renders a configurable set of overlay widgets on top of the stream content. Overlays are managed through the widget editor accessible from the Stream tab.

### Built-in Widgets

| Widget | Description |
|--------|-------------|
| **Thought Bubble** | Displays the agent's latest thought or reasoning, auto-fades after a configurable delay (2-30s) |
| **Action Ticker** | Scrolling horizontal strip of recent actions and tool calls (configurable 3-20 visible items) |
| **Alert Popup** | Animated fade-in/out alerts for new viewers and chat messages |
| **Viewer Count** | Live viewer count badge with pulsing green dot |
| **Branding** | Agent name/logo watermark with configurable opacity |
| **Custom HTML** | User-defined HTML overlay for full extensibility |

Each widget supports position (x, y, width, height), z-index, and an enable/disable toggle.

### Custom HTML Widgets

The Custom HTML widget lets you inject arbitrary HTML into the overlay layer. Use it for custom branding, animated graphics, or third-party widget embeds. The widget can subscribe to configurable event streams for dynamic content.

### Overlay Layouts

Overlay layouts are JSON-serializable and versioned. Each streaming destination can have its own layout, and layouts are persisted to `data/stream/stream-settings.json`.

## Voice on Stream

The TTS-to-RTMP bridge generates speech server-side and pipes audio directly into the FFmpeg stream.

### How It Works

1. Agent generates a response
2. TTS provider converts text to PCM audio (s16le, 24 kHz, mono)
3. Audio chunks are piped to FFmpeg via pipe:3 (4th stdio fd) every 50ms
4. Silence is written when the agent is not speaking

### Supported TTS Providers

- **ElevenLabs** — high-quality neural voices
- **OpenAI** — OpenAI TTS voices
- **Edge (Microsoft)** — browser-native Microsoft Edge TTS

### Voice Settings

| Setting | Description |
|---------|-------------|
| **Enabled** | Toggle voice on/off for the stream |
| **Auto-Speak** | Automatically speak agent responses when enabled |
| **Provider** | Select TTS provider (auto-detected if not set) |

The `StreamVoiceConfig` component displays a compact control panel with toggle, provider status, and a test button. The test button only appears when the stream is live and the TTS bridge is attached.

<Warning>
Voice requires valid TTS API keys configured in Settings > Secrets. Maximum text length per speak request is 2000 characters. The agent cannot speak again until the current speech finishes.
</Warning>

## Stream Settings

| Setting | Description |
|---------|-------------|
| **Theme** | Visual theme applied to the stream canvas |
| **Avatar** | VRM avatar index displayed on stream |
| **Volume** | Stream audio volume (0-100) |
| **Mute** | Mute/unmute stream audio |

### Agent Mode Detection

The StreamView automatically detects the agent's current activity mode and renders appropriate content:

| Mode | Content |
|------|---------|
| **Gaming** | Game iframe |
| **Terminal** | Stream terminal |
| **Chatting** | Chat content overlay |
| **Idle** | Idle content with avatar |

## Stream Components

The StreamView is composed of several sub-components:

- **StatusBar** — top bar with mode indicator, viewer count, stream toggle, volume slider, and destination selector.
- **StreamVoiceConfig** — compact voice control panel.
- **OverlayLayer** — renders all enabled widgets at their configured positions.
- **AvatarPip** — VRM avatar picture-in-picture window.
- **ActivityFeed** — right sidebar event stream.
- **ChatTicker** — bottom scrolling chat message ticker.

## API Reference

### Stream Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/stream/live` | Start streaming using destination credentials |
| POST | `/api/stream/offline` | Stop streaming |
| GET | `/api/stream/status` | Stream health (running, FFmpeg alive, uptime, frames, volume, muted) |

### Audio

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/stream/volume` | Set volume (0-100) |
| POST | `/api/stream/mute` | Mute stream |
| POST | `/api/stream/unmute` | Unmute stream |

### Voice (TTS)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stream/voice` | Get voice config and status |
| POST | `/api/stream/voice` | Save voice settings |
| POST | `/api/stream/voice/speak` | Trigger TTS with custom text (max 2000 chars) |

### Destinations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/streaming/destinations` | List available streaming destinations |
| POST | `/api/streaming/destination` | Set active destination |

### Overlays

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stream/overlay-layout` | Read overlay layout (supports `?destination=<id>`) |
| POST | `/api/stream/overlay-layout` | Save overlay layout |

### Visual Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stream/settings` | Read theme/avatar settings |
| POST | `/api/stream/settings` | Save theme/avatar settings |
