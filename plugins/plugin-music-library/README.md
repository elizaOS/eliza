# @elizaos/plugin-music-library

A comprehensive plugin for elizaOS that provides music data storage, user preferences, analytics, external music metadata APIs, and YouTube search functionality.

## Features

### Music Metadata & External APIs
- **Track Information**: Extract metadata from YouTube URLs and track titles
- **Artist Information**: Get artist details from multiple sources
- **Album Information**: Retrieve album metadata
- **Multiple Sources**: MusicBrainz, Last.fm, Genius, TheAudioDB, Wikipedia
- **Fallback Chain**: Automatically tries multiple sources for best results
- **Rate Limiting**: Built-in rate limiting for all APIs
- **Retry Logic**: Automatic retry with exponential backoff
- **Service Health Monitoring**: Tracks status of all integrated APIs

### YouTube Integration
- **YouTube Search**: Search for tracks, artists, albums on YouTube
- **Smart Query Parsing**: Detects artist, genre, mood intents
- **URL Extraction**: Parse and validate YouTube URLs

### Music Library & Data Storage
- **Track Database**: Store and discover tracks, albums, artists
- **Play History**: Track what's been played and when
- **Request Tracking**: Log who requested which tracks
- **High-Quality Music Storage**: Store original high-quality audio files for archival
  - Organized by artist/album/track
  - Full metadata indexing
  - Optional high-quality vs standard quality modes

### Playlists
- **Create & Save**: Save playlists for users
- **Load & List**: Load and list playlists
- **Share**: Share playlists between users

### User Preferences
- **Favorite Tracks**: Track user favorite tracks
- **Favorite Artists**: Track favorite artists
- **Disliked Tracks**: Remember what users don't like
- **Genre Preferences**: Learn genre preferences over time
- **Room Preferences**: Aggregate preferences across users in a room

### Analytics
- **Play Tracking**: Track every play with duration and requester
- **Session Tracking**: Track listening sessions
- **Statistics**: Get analytics for rooms (top tracks, artists, genres)

### Anti-Repetition
- **Repetition Control**: Prevent tracks from replaying too soon
- **Variety Scoring**: Score tracks by variety to encourage diverse playlists

## Installation

As this is a workspace package, it's installed as part of the elizaOS monorepo:

```bash
bun install
```

## Configuration

The plugin works out of the box with MusicBrainz (free, no API key needed). For enhanced features, configure additional APIs:

### Storage Configuration

```bash
# High-quality music storage directory (default: ./storage/music)
MUSIC_STORAGE_DIR=/path/to/storage

# Store highest quality available (default: true)
MUSIC_STORAGE_HIGH_QUALITY=true
```

**Storage vs Cache**:
- **Music Library Storage** (this plugin): Permanent high-quality storage for archival and library management
  - Original quality files (WebM, MP4, etc.)
  - Organized by artist/album/track
  - Indexed for browsing and discovery
  - No expiration
- **Music Player Cache** (`plugin-music-player`): Temporary Discord-optimized cache for performance
  - Pre-transcoded to Opus/WebM for Discord
  - Flat cache directory
  - 7-day TTL with automatic cleanup
  - Trades disk space for reduced CPU/bandwidth

### Optional Configuration

Add these to your `.env` file for enhanced metadata:

```bash
# MusicBrainz (optional - custom User-Agent)
MUSICBRAINZ_USER_AGENT=YourAppName/1.0.0 (https://yourapp.com)

# Last.fm API (free tier with signup)
LASTFM_API_KEY=your_lastfm_api_key

# Genius API (free tier with signup) - for lyrics URLs
GENIUS_API_KEY=your_genius_api_key

# TheAudioDB API (free tier with signup) - for high-quality artwork
THEAUDIODB_API_KEY=your_theaudiodb_api_key
```

## Usage

Add the plugin to your character configuration:

```json
{
  "plugins": [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-music-library"
  ]
}
```

### Service Usage

Access services directly in your code:

```typescript
const musicLibrary = runtime.getService('musicLibrary');

// Get track info
const trackInfo = await musicLibrary.getTrackInfo('https://youtube.com/watch?v=...');

// Save a playlist
const playlist = await musicLibrary.savePlaylist(userId, {
  name: 'My Playlist',
  tracks: [...]
});

// Track analytics
await musicLibrary.trackTrackPlayed(roomId, track, duration, requester);

// Get user preferences
const prefs = await musicLibrary.getUserPreferences(userId);
```

### Actions

Available actions:
- `MUSIC_LIBRARY` - Consolidated planner-facing action.
  - `op=playlist`, `subaction=save|load|delete|add` - Manage playlists.
  - `op=search-youtube` - Search YouTube for music.
  - `op=play-query` - Smart music query parser.
  - `op=download` - Download music to the local library.

Legacy planner action names such as `PLAYLIST_OP`, `PLAYLIST`,
`SEARCH_YOUTUBE`, `PLAY_MUSIC_QUERY`, and `DOWNLOAD_MUSIC` are retained as
similes for `MUSIC_LIBRARY`.

## Integration with Other Plugins

This plugin is designed to work with:

- **@elizaos/plugin-music-player**: Provides data storage for playback
- **@elizaos/plugin-radio**: Provides preferences and analytics for radio programming
- **@elizaos/plugin-sql**: Required for data persistence

## API

### Services

#### MusicInfoService
- `getTrackInfo(urlOrTitle: string)`: Get track metadata
- `getArtistInfo(artistName: string)`: Get artist information
- `getAlbumInfo(albumTitle: string, artistName?: string)`: Get album information

#### YouTubeSearchService
- `search(query: string, maxResults?: number)`: Search YouTube
- `extractVideoId(url: string)`: Extract video ID from URL

#### MusicLibraryService
- `addSong(song)`, `getSong(url)`, `getRecentSongs(limit)`, `searchLibrary(query)`
- `savePlaylist(entityId, playlist)`, `loadPlaylists(entityId)`
- `trackTrackPlayed(roomId, track, duration)`, `trackTrackRequest(entityId, track)`
- `getAggregatedRoomPreferences(roomId)` returns combined favorites/dislikes for auto-fill logic
- Exposes `repetitionControl` utilities and a configured `spotifyClient`

### Components

See individual component files for detailed APIs:
- `components/musicLibrary.ts` - Track/album/artist database
- `components/playlists.ts` - Playlist management
- `components/preferences.ts` - User preferences
- `components/analytics.ts` - Analytics tracking
- `components/repetitionControl.ts` - Anti-repetition logic

## License

MIT
