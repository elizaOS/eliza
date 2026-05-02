# @elizaos/plugin-music-player

A pure music playback engine for elizaOS that handles audio streaming, queue management, and cross-fading using a **broadcast architecture** that enables resilient, multi-consumer audio delivery.

## Features

- **Queue Management**: Add, remove, skip, shuffle tracks
- **Cross-fading**: Smooth transitions between tracks
- **Audio Streaming API**: RESTful endpoints for web streaming
- **Discord Voice Integration**: Play audio in Discord voice channels
- **Broadcast Architecture**: Stream to multiple consumers (Discord + web) simultaneously
- **Auto-Reconnection**: Discord hiccups don't interrupt playback
- **Silence Injection**: Connections stay alive when queue is empty
- **Non-Blocking**: Slow web clients don't affect Discord playback
- **Discord-Optimized Audio Cache**: Transcoded files ready for instant Discord playback
- **Optional Analytics**: Integrates with plugin-music-library for play tracking (if available)

## Installation

```bash
bun install
```

## Configuration

### Required Environment Variables

None required for basic playback.

### Optional Environment Variables

```bash
# Discord-optimized audio cache directory (default: ./cache/audio)
# This cache stores transcoded files for instant Discord playback
AUDIO_CACHE_DIR=/path/to/cache
```

## Audio Caching Architecture

The plugin includes a **Discord-optimized audio cache** that stores transcoded audio files:
- **Purpose**: Trade disk space for reduced CPU/bandwidth usage
- **Format**: Pre-transcoded to Discord-friendly formats (Opus/WebM)
- **Location**: Configurable via `AUDIO_CACHE_DIR` (default: `./cache/audio`)
- **Lifetime**: 7-day TTL with automatic cleanup
- **Use Case**: Frequently played tracks, pre-buffering for crossfading

**Note**: This is different from `plugin-music-library`'s storage:
- **Music Player Cache**: Temporary, transcoded, performance-optimized
- **Music Library Storage**: Permanent, high-quality originals, archival

## Usage

Add the plugin to your character configuration:

```json
{
  "plugins": [
    "@elizaos/plugin-discord",
    "@elizaos/plugin-music-player"
  ]
}
```

### Basic Playback

The plugin provides actions for basic music control:

- `PLAY_AUDIO` - Play audio from YouTube or any supported platform (YouTube, SoundCloud, Spotify, etc.)
- `SKIP_TRACK` - Skip the current track
- `SHOW_QUEUE` - Display the current queue

### Progressive status (`ProgressiveMessage`)

`PLAY_AUDIO` and related actions use a small **`ProgressiveMessage`** helper (`src/utils/progressiveMessage.ts`) that mirrors the API from `@elizaos/plugin-discord`: call **`update(text)`** for transient status, **`complete(text)`** / **`fail(text)`** for the final line.

**Contract:** Every method invokes the standard elizaOS **`HandlerCallback`** with `{ text, source }` — no Milady-specific fields.

**Why it works in the Milady dashboard:** The API chat path treats **repeated action callbacks** as **replace-in-place** for the suffix after the model’s streamed text (SSE snapshot), so “Searching…” becomes “Now playing…” in the **same** bubble instead of concatenating every update. **Why that matters:** Discord edits one message; without server-side replace semantics, the web UI would show one long glued status string.

**Docs:** In the Milady monorepo see [`docs/runtime/action-callback-streaming.md`](../../docs/runtime/action-callback-streaming.md).

### Service API

Access the music service directly:

```typescript
const musicService = runtime.getService('music') as MusicService;

// Add track to queue
await musicService.addTrack(guildId, {
  url: 'https://youtube.com/watch?v=...',
  title: 'Song Title',
  requestedBy: userId,
});

// Skip track
await musicService.skip(guildId);

// Get current track
const track = musicService.getCurrentTrack(guildId);

// Get queue
const queue = musicService.getQueueList(guildId);

// Pause/Resume
await musicService.pause(guildId);
await musicService.resume(guildId);

// Shuffle
musicService.shuffle(guildId);

// Clear queue
musicService.clear(guildId);
```

### Broadcast API (Advanced)

For custom audio consumers:

```typescript
import type { IAudioBroadcast, BroadcastState } from '@elizaos/plugin-music-player';

const musicService = runtime.getService('music') as MusicService;
const broadcast = musicService.getBroadcast(guildId);

// Check broadcast state
console.log(broadcast.state); // 'live' | 'silence' | 'stopped'

// Get subscriber count
console.log(broadcast.getSubscriberCount());

// Subscribe a custom consumer
const subscription = broadcast.subscribe('my-app');

// Use the stream
subscription.stream.on('data', (chunk) => {
  // Process audio data
});

// Clean up
subscription.unsubscribe();
```

### Streaming API Routes

The plugin provides HTTP endpoints for audio streaming:

#### GET /music-player/stream?guildId={guildId}

Stream the currently playing audio. Supports both WebM (default) and Shoutcast/Icecast formats.

**Parameters:**
- `guildId` - Discord guild ID (required)
- `format` - Stream format: `webm` or `shoutcast` (optional, default: `webm`)

**Headers:**
- `icy-metadata: 1` - Enable Shoutcast metadata injection

**Response:**
- `Content-Type: audio/webm; codecs=opus` (for WebM)
- `Content-Type: audio/mpeg` (for Shoutcast)
- Continuous audio stream

#### GET /music-player/now-playing?guildId={guildId}

Get information about the currently playing track.

**Response:**
```json
{
  "track": {
    "id": "...",
    "title": "Song Title",
    "url": "https://youtube.com/watch?v=...",
    "duration": 180,
    "requestedBy": "user-id",
    "addedAt": 1234567890
  },
  "streamUrl": "/music-player/stream?guildId=..."
}
```

#### GET /music-player/queue?guildId={guildId}

Get the current queue status.

**Response:**
```json
{
  "currentTrack": { ... },
  "queue": [
    { ... },
    { ... }
  ],
  "queueLength": 5
}
```

## Optional Integration

### With plugin-music-library

If `@elizaos/plugin-music-library` is loaded, the music player will automatically:
- Track play statistics
- Log track requests
- Record skip events

This integration is optional - the player works standalone without the library.

## Dependencies

- `@elizaos/plugin-discord` - Optional for Discord voice integration (web streaming works without it)

## Architecture

The music player is designed as a pure playback engine with a **broadcast-centric architecture**:

```
┌──────────────────────────────────────────────────────────────┐
│                    MUSIC-PLAYER PLUGIN                        │
│                                                               │
│  MusicQueue → Broadcast → StreamMultiplexer → [Consumers]    │
│                              ↓                                │
│                         StreamCore                            │
│                    (audio + silence gen)                      │
└──────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
        ┌─────▼─────┐                  ┌──────▼──────┐
        │  Discord  │                  │    Web      │
        │  (auto)   │                  │  Clients    │
        └───────────┘                  └─────────────┘
```

### Key Principles

- **No Business Logic**: No playlist management, preferences, or analytics
- **Stateless**: Only manages active playback queues
- **Broadcast Model**: Single source, multiple independent consumers
- **Resilient**: Continues playing even when consumers disconnect/reconnect
- **Plugin Independence**: Works with or without discord plugin

### IAudioBroadcast Interface

The broadcast interface allows external consumers to subscribe to audio streams:

```typescript
import type { IAudioBroadcast } from '@elizaos/plugin-music-player';

// Get broadcast for a guild
const broadcast = musicService.getBroadcast(guildId);

// Subscribe to receive audio
const subscription = broadcast.subscribe('my-consumer-id');
subscription.stream.pipe(myAudioOutput);

// Listen for events
broadcast.on('metadata', (track) => {
  console.log(`Now playing: ${track.title}`);
});

broadcast.on('stateChange', (state) => {
  // 'live' | 'silence' | 'stopped'
});

// Unsubscribe when done
subscription.unsubscribe();
```

### Auto-Wiring with Discord

When both `plugin-music-player` and `plugin-discord` are loaded:

1. **Zero configuration needed** - plugins auto-wire on startup
2. **Discord auto-subscribes** - when music plays, Discord receives the stream
3. **Auto-reconnection** - Discord hiccups are handled transparently
4. **No radio plugin required** - basic playback works immediately

### Silence Injection

When the queue is empty, the broadcast emits **silence frames** instead of closing:

- Keeps Discord voice connection alive (no timeout disconnects)
- Web streaming connections stay open
- Seamless transition when new tracks are added

### Non-Blocking Consumers

Each consumer gets an independent stream:

- Slow web client? Only that client drops frames
- Discord unaffected by web client performance
- Multiple web listeners work simultaneously

## Cross-fading

The player supports seamless cross-fading between tracks:

- Pre-buffers the next track 30 seconds before current track ends
- Smooth transitions with configurable fade duration (default: 3 seconds)
- Maintains continuous audio stream for web listeners

## License

MIT

