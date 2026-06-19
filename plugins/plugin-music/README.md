# @elizaos/plugin-music

A comprehensive music plugin for elizaOS that provides music library management, playback, queue management, playlists, analytics, YouTube search, multi-source metadata APIs, AI music generation, and a streaming HTTP API for Eliza agents.

## Capabilities

### Music Playback
- Stream audio from YouTube URLs or direct media URLs to Discord voice channels or web clients
- Queue management: add, view, clear tracks
- Transport controls: play, pause, resume, skip, stop
- Multi-zone and multi-route audio (broadcast to multiple Discord guilds or web streams simultaneously)
- Live HTTP streaming endpoint (OGG/Shoutcast/Icecast) for web players

### Music Library & Playlists
- Persistent song library with title, artist, album, and URL indexing
- Create, save, load, and share user playlists
- Play history and request tracking per user and room
- Smart play query: find and queue the best match from YouTube for a natural-language request
- Download audio to a local library archive

### Metadata & Discovery
- Track, artist, and album metadata from MusicBrainz (no API key needed), Last.fm, Genius, TheAudioDB, and Wikipedia
- YouTube search with smart query parsing (artist, genre, mood)
- Spotify-backed recommendations
- Automatic fallback chain across sources

### User Preferences & Analytics
- Per-user favorite tracks and artists, disliked tracks, genre preferences
- Aggregated room preferences for auto-fill and DJ logic
- Anti-repetition scoring to encourage variety
- Play count, session, and tip analytics

### AI Music Generation (Suno)
- Generate original music from a text prompt (`generate`)
- Extend existing audio (`extend`)
- Custom generation with style, BPM, key, and reference audio (`custom_generate`)
- Requires `SUNO_API_KEY`

## Installation

This plugin is part of the elizaOS monorepo:

```bash
bun install
```

Add to a character config:

```json
{
  "plugins": [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-music"
  ]
}
```

`@elizaos/plugin-sql` is recommended for persistent library, playlist, and preference storage.

## Auto-Enable

The plugin auto-enables when any of these settings are present:
`LASTFM_API_KEY`, `GENIUS_API_KEY`, `THEAUDIODB_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`.

## Configuration

### Required System Dependencies

- **`yt-dlp`** — Must be in PATH for audio download and caching. Install via `brew install yt-dlp`, `pipx install yt-dlp`, or download from [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp). Override path with `YT_DLP_PATH`.
- **`ffmpeg` / `ffprobe`** — Bundled via `ffmpeg-static`/`ffprobe-static`; override with `FFMPEG_PATH` and `FFPROBE_PATH`.

### Optional API Keys

Add to `.env` or character settings for enhanced metadata and features:

```bash
# Last.fm — artist/track metadata (free with signup)
LASTFM_API_KEY=your_lastfm_api_key

# Genius — lyrics URLs (free with signup)
GENIUS_API_KEY=your_genius_api_key

# TheAudioDB — high-quality artwork (free with signup)
THEAUDIODB_API_KEY=your_theaudiodb_api_key

# Spotify — recommendations
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret

# Suno — AI music generation
SUNO_API_KEY=your_suno_api_key

# MusicBrainz — custom User-Agent (optional; free, no key needed)
MUSICBRAINZ_USER_AGENT=YourAppName/1.0.0 (https://yourapp.com)
```

### Other Settings

```bash
# Audio cache directory (default: <cwd>/cache/audio)
AUDIO_CACHE_DIR=/path/to/cache

# Download quality preference (default: mp3_320)
MUSIC_QUALITY_PREFERENCE=mp3_320

# YouTube cookies file for age-restricted content
YOUTUBE_COOKIES=/path/to/cookies.txt

# Proxy for yt-dlp
YTDLP_PROXY=http://proxy:port

# Enable verbose music debug logging
ELIZA_MUSIC_DEBUG=1
```

## Actions

All music operations route through a single **`MUSIC`** action with a verb-shaped `action` parameter.

| Subaction | Description |
|-----------|-------------|
| `play` | Play a track by URL or query |
| `pause` | Pause current playback |
| `resume` | Resume paused playback |
| `skip` | Skip to next track (requires `confirmed: true`) |
| `stop` | Stop playback (requires `confirmed: true`) |
| `queue_view` | Show current queue |
| `queue_add` | Add a track to the queue (requires `confirmed: true`) |
| `queue_clear` | Clear the queue (requires `confirmed: true`) |
| `playlist_play` | Load and play a saved playlist |
| `playlist_save` | Save current queue as a playlist (requires `confirmed: true`) |
| `search` | Search YouTube for music |
| `play_query` | Smart natural-language music query (search + play) |
| `download` | Download a track to the local library (requires `confirmed: true`) |
| `play_audio` | Play a direct media URL |
| `set_routing` | Configure audio routing mode |
| `set_zone` | Configure audio zones |
| `generate` | AI-generate music from prompt (Suno) |
| `extend` | Extend existing Suno audio |
| `custom_generate` | Custom Suno generation with style/BPM/key |

The `MUSIC` action aggregates similes from its sub-handlers, so legacy intent names such as `PAUSE_MUSIC`, `PLAY_YOUTUBE`, `PLAYLIST`, `SEARCH_YOUTUBE`, `PLAY_MUSIC_QUERY`, `DOWNLOAD_MUSIC`, and `GENERATE_MUSIC` still match. The verb-shaped aliases in `SUBACTION_ALIASES` (e.g. `playlist`, `search_youtube`, `routing`, `zones`, `next`, `unpause`) are also accepted for the `action` parameter.

## HTTP Streaming API

The plugin registers routes on the agent's HTTP server (prefix `/api/<agentId>/music-player/`):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/stream` | public | Live audio stream |
| GET | `/now-playing` | public | Now-playing metadata |
| GET | `/queue` | public | Queue JSON |
| GET | `/status` | public | Playback status |
| POST | `/control/pause` | authenticated | Pause |
| POST | `/control/resume` | authenticated | Resume |
| POST | `/control/stop` | authenticated | Stop |
| POST | `/control/skip` | authenticated | Skip |

Authenticated endpoints accept `Authorization: Bearer <token>`, `X-Eliza-Token`, or `X-Api-Key`.

## Services

Access from agent code via `runtime.getService(...)`:

- `runtime.getService('music')` → `MusicService` — playback engine, queue, routing
- `runtime.getService('musicLibrary')` → `MusicLibraryService` — library, playlists, preferences, analytics

## Integration

This plugin works alongside:

- **`@elizaos/plugin-discord`** — Provides voice channel playback (wired automatically on init)
- **`@elizaos/plugin-sql`** — Required for persistent library and playlist storage
- **`@elizaos/plugin-suno`** — Required for AI generation subactions

