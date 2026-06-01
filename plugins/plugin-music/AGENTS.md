# @elizaos/plugin-music

Music library, discovery, playlists, analytics, playback engine, queue, routing API, and streaming routes for Eliza agents.

## Purpose / Role

Adds comprehensive music capability to an Eliza agent: playback of YouTube and direct-URL audio, queue management, playlist persistence, smart music queries, YouTube search, Suno-backed AI music generation, multi-zone audio routing, and a streaming HTTP API. Auto-enabled when any of `LASTFM_API_KEY`, `GENIUS_API_KEY`, `THEAUDIODB_API_KEY`, `SPOTIFY_CLIENT_ID`, or `SPOTIFY_CLIENT_SECRET` is set; can also be loaded explicitly via character config.

## Plugin Surface

### Actions
- **`MUSIC`** (`src/actions/music.ts`) — Umbrella action. Dispatches all music operations via a verb-shaped `action` parameter: `play`, `pause`, `resume`, `skip`, `stop`, `queue_view`, `queue_add`, `queue_clear`, `playlist_play`, `playlist_save`, `search`, `play_query`, `download`, `play_audio`, `set_routing`, `set_zone`, `generate`, `extend`, `custom_generate`. Legacy aliases are accepted (e.g. `playlist`, `search_youtube`, `routing`, `zones`).

### Services
- **`MusicService`** (`src/service.ts`, serviceType: `"music"`) — Core playback engine. Manages per-guild queues, audio broadcasting, Discord voice wiring, audio routing, and the `AudioCacheService`.
- **`MusicLibraryService`** (`src/services/musicLibraryService.ts`, serviceType: `"musicLibrary"`) — Library, playlists, preferences, analytics, repetition control, song memory, Spotify client. Aggregated service over all component modules.

### Providers
- **`MUSIC_INFO`** (`src/providers/musicInfoProvider.ts`) — Injects track/artist/album metadata into agent state. Contexts: `media`, `knowledge`.
- **`WIKIPEDIA_MUSIC`** (`src/providers/wikipediaProvider.ts`) — Extracts music context from Wikipedia via LLM parsing. Contexts: `media`, `knowledge`.
- **`MUSIC_LIBRARY`** (`src/providers/musicLibraryProvider.ts`) — Library stats, recent/most-played songs. Contexts: `media`, `knowledge`.
- **`musicPlaylists`** (`src/providers/musicPlaylistsProvider.ts`) — User playlists as JSON context. Contexts: `media`, `knowledge`.
- **`musicQueue`** (`src/providers/musicQueueProvider.ts`) — Current queue and now-playing track. Contexts: `media`, `knowledge`.

### Routes (`src/routes.ts`)
All paths are under the plugin's mount prefix (e.g. `/api/<agentId>/music-player/`):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/stream` | public | Live audio stream (OGG/Shoutcast/Icecast) |
| GET | `/stream/:guildId` | public | Same, guildId in path param |
| GET | `/now-playing` | public | Now-playing metadata JSON |
| GET | `/now-playing/:guildId` | public | Same, guildId in path param |
| GET | `/queue` | public | Queue JSON |
| GET | `/queue/:guildId` | public | Same, guildId in path param |
| GET | `/status` | public | Playback status JSON |
| POST | `/control/pause` | authenticated | Pause playback |
| POST | `/control/resume` | authenticated | Resume playback |
| POST | `/control/stop` | authenticated | Stop playback |
| POST | `/control/skip` | authenticated | Skip current track |

### Search Categories
Registered via `registerMusicLibrarySearchCategories` on `init`:
- `youtube` — YouTube video/music search
- `wikipedia_music` — Wikipedia music metadata lookup

## Layout

```
src/
  index.ts                    Plugin entry; exports musicPlugin (Plugin object)
  service.ts                  MusicService (playback engine, queues, routing)
  routes.ts                   Streaming + control HTTP routes
  queue.ts                    MusicQueue and QueuedTrack types
  contracts.ts                IAudioBroadcast, BroadcastState, BroadcastTrackMetadata
  search-category.ts          Search category registrations (YouTube, Wikipedia)
  route-fallback.ts           tryHandleMusicPlayerStatusFallback helper
  discordVoice.ts             Discord voice type bridge
  actions/
    music.ts                  MUSIC umbrella action (dispatcher)
    music-player-action-docs.ts  Action parameter docs for the music-player surface
    musicLibrary.ts           Library sub-handler (playlist, search, play_query, download)
    playAudio.ts              play_audio sub-handler
    playbackOp.ts             Transport controls (pause/resume/skip/stop/queue)
    manageRouting.ts          set_routing sub-handler
    manageZones.ts            set_zone sub-handler
    downloadMusic.ts          Download logic
    searchYouTube.ts          YouTube search logic
    playMusicQuery.ts         Smart play_query logic
    playlistOp.ts             Playlist save/load logic
    confirmation.ts           Confirmation merge helpers
  providers/
    musicInfoProvider.ts      MUSIC_INFO provider
    wikipediaProvider.ts      WIKIPEDIA_MUSIC provider
    musicLibraryProvider.ts   MUSIC_LIBRARY provider
    musicPlaylistsProvider.ts musicPlaylists provider
    musicQueueProvider.ts     musicQueue provider
  services/
    musicLibraryService.ts    MusicLibraryService (aggregates all components)
    musicInfoService.ts       MusicInfoService + MusicInfoHelper
    youtubeSearch.ts          YouTubeSearchService + YouTubeSearchHelper
    musicEntityDetectionService.ts  Entity detection from conversation
    musicStorage.ts           MusicStorageService (permanent archive storage)
    audioCache.ts             AudioCacheService (yt-dlp download + Opus transcoding)
    smartMusicFetch.ts        SmartMusicFetchService
    spotifyClient.ts          SpotifyClient (recommendations)
    wikipediaClient.ts        WikipediaService + WikipediaClient
    wikipediaExtractionService.ts  LLM-based Wikipedia extraction
    geniusClient.ts           Genius API (lyrics URLs)
    lastFmClient.ts           Last.fm API (artist/track metadata)
    musicBrainzClient.ts      MusicBrainz API (metadata, free tier)
    theAudioDbClient.ts       TheAudioDB API (artwork)
    serviceStatus.ts          ServiceHealth tracking types
  components/
    musicLibrary.ts           Track/album/artist database functions
    playlists.ts              Playlist CRUD functions
    preferences.ts            User preference tracking
    analytics.ts              DJ analytics and play-tracking
    repetitionControl.ts      Anti-repetition logic
    songMemory.ts             Song memory and request history
    djGuildSettings.ts        Per-guild DJ config
    djIntroOptions.ts         DJ intro prompt options
    djTips.ts                 DJ tip tracking
    componentData.ts          Shared component data helpers
    storageContext.ts         Storage context helpers
  core/
    broadcast.ts              Broadcast (stream multiplexer)
    streamCore.ts             Low-level stream helpers
    streamMultiplexer.ts      Multi-subscriber stream fan-out
    index.ts                  Re-exports Broadcast
  router/
    audioRouter.ts            AudioRouter (routing mode management)
    zoneManager.ts            ZoneManager (multi-zone audio)
    mixSessionManager.ts      MixSessionManager (mix sessions)
    index.ts                  Re-exports router types
  types/
    index.ts                  TrackInfo, ArtistInfo, AlbumInfo, MusicInfoResult
    audioFeatures.ts          AudioFeatures, RecommendationRequest, TrackRecommendation
  utils/
    ffmpegEnv.ts              FFmpeg binary resolution
    ytdlpCheck.ts             yt-dlp binary discovery
    ytdlpCli.ts               yt-dlp CLI helpers
    ytdlpYoutube.ts           YouTube-specific yt-dlp options
    ytdlpFallback.ts          Fallback fetch logic
    musicDebug.ts             Debug logging helpers
    playbackTransportIntent.ts  Intent detection for transport controls
    resolveMusicGuildId.ts    Guild ID resolution helpers
    json.ts                   JSON parse helpers
    opusBroadcastNormalize.ts Opus broadcast normalization
    progressiveMessage.ts     Progressive message helpers
    retry.ts                  Retry utility
    smartFetchService.ts      Smart fetch service
    streamFallback.ts         Stream fallback logic
```

## Commands

```bash
bun run --cwd plugins/plugin-music build          # tsup build to dist/
bun run --cwd plugins/plugin-music dev            # tsup watch mode
bun run --cwd plugins/plugin-music test           # vitest run
bun run --cwd plugins/plugin-music typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-music lint           # biome check --write --unsafe
bun run --cwd plugins/plugin-music lint:check     # biome check (no write)
bun run --cwd plugins/plugin-music format         # biome format --write
bun run --cwd plugins/plugin-music format:check   # biome format (no write)
bun run --cwd plugins/plugin-music clean          # rm -rf dist .turbo .turbo-tsconfig.json tsconfig.tsbuildinfo
bun run --cwd plugins/plugin-music test:e2e       # live smoke (requires running agent)
```

## Config / Env Vars

### Runtime settings (via `runtime.getSetting(...)`)
| Setting | Required | Default | Purpose |
|---------|----------|---------|---------|
| `LASTFM_API_KEY` | No | — | Last.fm metadata; triggers auto-enable |
| `GENIUS_API_KEY` | No | — | Genius lyrics URLs; triggers auto-enable |
| `THEAUDIODB_API_KEY` | No | — | TheAudioDB artwork; triggers auto-enable |
| `SPOTIFY_CLIENT_ID` | No | — | Spotify recommendations; triggers auto-enable |
| `SPOTIFY_CLIENT_SECRET` | No | — | Spotify auth; triggers auto-enable |
| `SUNO_API_KEY` | No | — | AI music generation (generate/extend/custom_generate subactions) |
| `MUSICBRAINZ_USER_AGENT` | No | `ElizaOS-MusicInfo/1.0.0 (https://github.com/elizaos/eliza)` | Custom User-Agent for MusicBrainz API |
| `MUSIC_QUALITY_PREFERENCE` | No | `mp3_320` | Download quality preference |
| `AUDIO_CACHE_DIR` | No | `<cwd>/cache/audio` | Directory for pre-transcoded audio cache |

### Process env vars
| Variable | Purpose |
|----------|---------|
| `YOUTUBE_COOKIES` | Path to Netscape cookies file for age-restricted YouTube content |
| `YTDLP_COOKIES` | Alternative cookies path for yt-dlp |
| `AUDIO_CACHE_FORMAT` | Output audio format override |
| `ELIZA_MUSIC_DEBUG` | Enable verbose music debug logging |
| `ELIZA_MUSIC_BROADCAST_NORMALIZE` | Enable broadcast audio normalization |
| `FFMPEG_PATH` / `FFMPEG_LOCATION` | Override FFmpeg binary path |
| `FFPROBE_PATH` | Override ffprobe binary path |
| `HTTP_PROXY` / `HTTPS_PROXY` | Proxy for outbound requests |
| `YOUTUBE_PROXY` / `YTDLP_PROXY` | Proxy specifically for yt-dlp |
| `YTDLP_JS_RUNTIMES` | JS runtime list for yt-dlp (e.g. `nodejs`) |
| `YTDLP_YOUTUBE_EXTRACTOR_ARGS` | Extra args passed to the YouTube extractor |
| `SERVER_URL` | Base URL for streaming route self-references |

## How to Extend

### Add an action sub-handler
1. Create `src/actions/<myHandler>.ts` exporting an `Action` object with `name`, `validate`, `handler`, and `examples`.
2. Add a new verb to `MUSIC_SUBACTIONS` in `src/actions/music.ts`.
3. Add an alias entry to `SUBACTION_ALIASES` if needed.
4. Add a `DispatchKind` branch in `dispatchKindFor()` and handle it in the `handler` switch.

### Add a provider
1. Create `src/providers/<myProvider>.ts` exporting a `Provider` object (name, description, contexts, get).
2. Import and add it to the `providers` array in `src/index.ts`.

### Add a service
1. Extend `MusicLibraryService` with new methods if the feature belongs in the library layer, or create a new `Service` subclass under `src/services/`.
2. Add the new service class to `services: [...]` in the `musicPlugin` object in `src/index.ts` (if standalone) and export from `src/index.ts`.

## Conventions / Gotchas

- **yt-dlp required at runtime.** Audio download and caching depend on `yt-dlp` in PATH. Discovery order: `YT_DLP_PATH` env → common system paths → `scripts/bin/yt-dlp`. Install via `brew install yt-dlp`, `pipx install yt-dlp`, or download binary.
- **ffmpeg/ffprobe required.** Bundled via `ffmpeg-static`/`ffprobe-static` deps; paths overridden by `FFMPEG_PATH`/`FFPROBE_PATH`.
- **Discord wiring is deferred.** The plugin init waits for the `discord` service load promise before wiring the voice manager. Music works web-only if Discord is absent.
- **`@elizaos/plugin-suno` is a hard dep.** Generation subactions (`generate`, `extend`, `custom_generate`) delegate to `sunoGenerateMusicHandler` from that package; they are skipped/unreachable if `SUNO_API_KEY` is absent.
- **Confirmation required for destructive ops.** `skip`, `stop`, `queue_clear`, `playlist_save`, and `download` require `confirmed: true` in the action options.
- **MusicBrainz is the zero-config metadata source.** All other metadata APIs (Last.fm, Genius, TheAudioDB) are optional enhancements.
- **MusicStorageService is not configured by env vars.** Storage dir and quality mode are constructor arguments; `MusicLibraryService` controls them internally.
- **`@elizaos/plugin-sql` is expected for persistence.** Library, playlists, preferences, and analytics components write to the agent's database via runtime memory/cache APIs.

See the repo-wide rules in the root `AGENTS.md`.
