import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

/**
 * Provider that injects music player system instructions into the agent's context
 * This explains all playback capabilities and technical features
 */
export const musicPlayerInstructionsProvider: Provider = {
  name: "MUSIC_PLAYER_INSTRUCTIONS",
  description:
    "Provides comprehensive music player documentation and playback capabilities",
  descriptionCompressed: "Music player docs and playback capabilities.",
  position: 5, // Early position for capability awareness

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const messageText = (message.content?.text || "").toLowerCase();

    // PERFORMANCE: Only provide instructions when user needs help about playback
    const needsInstructions =
      messageText.includes("help") ||
      messageText.includes("how do i play") ||
      messageText.includes("how can i play") ||
      messageText.includes("what can you play") ||
      messageText.includes("play music") ||
      messageText.includes("how to play") ||
      messageText.includes("playback") ||
      messageText.includes("audio quality") ||
      messageText.includes("streaming") ||
      messageText.includes("queue") ||
      messageText.includes("skip") ||
      messageText.includes("pause") ||
      messageText.includes("resume") ||
      messageText.includes("unpause") ||
      messageText.includes("stop playing") ||
      messageText.includes("stop the music") ||
      messageText.includes("cross-fade") ||
      messageText.includes("capabilities") ||
      messageText.includes("features") ||
      messageText.includes("how does") ||
      messageText.includes("what platforms");

    if (!needsInstructions) {
      return { text: "", data: {}, values: {} };
    }

    const instructions = `# Music Player System

## Core Playback Capabilities

### Supported Platforms
I can play audio from virtually any platform supported by yt-dlp:
- **YouTube** - Direct links or search queries
- **SoundCloud** - Tracks, playlists, and sets
- **Spotify** - Tracks and playlists (searches YouTube for the track)
- **Twitch** - VODs and clips
- **Vimeo** - Videos
- **Bandcamp** - Tracks and albums
- **Mixcloud** - DJ sets and podcasts
- **TikTok** - Video audio
- **Twitter/X** - Video audio
- **Instagram** - Video audio
- And 1000+ other sites supported by yt-dlp

### Playing Music

**Direct URLs:**
\`\`\`
play https://youtube.com/watch?v=...
play https://soundcloud.com/...
play https://open.spotify.com/track/...
\`\`\`

**Search Queries:**
If no URL is provided, I'll automatically search YouTube and play the top result:
\`\`\`
play Bohemian Rhapsody
play Queen - Bohemian Rhapsody
play Arctic Monkeys Do I Wanna Know
\`\`\`

**Smart Features:**
- Automatic platform detection
- Fallback search if link fails
- High-quality audio extraction
- Optimized Discord voice channel delivery

### Queue Management

**Add to Queue:**
\`\`\`
queue [song name or URL]
add to queue [song name or URL]
\`\`\`
Adds tracks to the queue without interrupting current playback.

**View Queue:**
\`\`\`
show queue
what's in the queue
what's playing next
\`\`\`

**Skip Tracks:**
\`\`\`
skip
skip this song
next track
\`\`\`

**Pause / Resume / Stop (separate actions — never PLAY_AUDIO):**
- User asks to **pause** → use action **PAUSE_MUSIC** (not PLAY_AUDIO with a "pause" parameter).
- **Resume** / unpause → **RESUME_MUSIC**
- **Stop** music or clear → **STOP_MUSIC**
- **Skip** / next → **SKIP_TRACK**

**Service API Methods:**
- \`addTrack()\` - Add to queue
- \`skip()\` - Skip current track
- \`pause()\` / \`resume()\` - Control playback
- \`shuffle()\` - Randomize queue
- \`clear()\` - Clear entire queue
- \`getCurrentTrack()\` - Get now playing info
- \`getQueueList()\` - Get full queue

## Advanced Features

### Cross-Fading
- Smooth transitions between tracks
- No awkward silence between songs
- Professional radio-style experience
- Configurable fade duration

### Audio Quality
- **High-quality extraction** - Best available audio format
- **Discord-optimized** - Pre-transcoded to Opus/WebM
- **Efficient caching** - Reduces CPU and bandwidth usage
- **Instant playback** - Cached tracks play immediately

### Audio Cache
The music player maintains a Discord-optimized audio cache:
- **Purpose**: Trade disk space for performance
- **Format**: Pre-transcoded to Discord-friendly formats (Opus/WebM)
- **Location**: Configurable via \`AUDIO_CACHE_DIR\` (default: \`./cache/audio\`)
- **Lifetime**: 7-day TTL with automatic cleanup
- **Benefits**: Frequently played tracks load instantly, enables smooth cross-fading

**Note**: This is different from music-library's storage:
- **Music Player Cache**: Temporary, transcoded, performance-optimized
- **Music Library Storage**: Permanent, high-quality originals, archival

### Broadcast Architecture
The player uses a resilient broadcast system:
- **Multi-consumer** - Stream to Discord + web simultaneously
- **Auto-reconnection** - Discord hiccups don't interrupt playback
- **Silence injection** - Keeps connections alive when queue is empty
- **Non-blocking** - Slow web clients don't affect Discord
- **Multiple subscribers** - Many clients can listen to same stream

### Voice Channel Integration
**Discord Voice:**
- Auto-join when music is requested
- Configurable auto-join on startup
- Voice connection management
- Push-to-talk support
- Automatic channel switching

**Requirements:**
- Must have \`@elizaos/plugin-discord\` enabled
- User or bot must be in a voice channel
- Bot needs voice permissions in the server

## HTTP Streaming API

### Stream Endpoint
**GET** \`/music-player/stream?guildId={guildId}\`

Stream currently playing audio in your preferred format:

**Parameters:**
- \`guildId\` (required) - Discord guild/server ID
- \`format\` (optional) - \`webm\` (default) or \`shoutcast\`

**Headers:**
- \`icy-metadata: 1\` - Enable Shoutcast metadata injection

**Response:**
- \`Content-Type: audio/webm; codecs=opus\` (WebM)
- \`Content-Type: audio/mpeg\` (Shoutcast)
- Continuous audio stream

**Examples:**
\`\`\`
# WebM stream (browser-friendly)
curl -N "http://localhost:3000/music-player/stream?guildId=123456789"

# Shoutcast stream (media player-friendly)
curl -H "icy-metadata: 1" "http://localhost:3000/music-player/stream?guildId=123456789&format=shoutcast"
\`\`\`

### Now Playing Endpoint
**GET** \`/music-player/now-playing?guildId={guildId}\`

Get information about the currently playing track:

**Response:**
\`\`\`json
{
  "title": "Song Title",
  "url": "https://youtube.com/watch?v=...",
  "duration": 240,
  "position": 120,
  "requestedBy": "user-id",
  "queueLength": 5
}
\`\`\`

## Advanced Multi-Bot Features

### Audio Routing (Experimental)
Route audio to multiple destinations:
- **Simulcast mode** - Same audio to multiple channels
- **Independent mode** - Different audio to different channels
- **Dynamic routing** - Change routes on the fly

\`\`\`
set mode simulcast
route main-stream to zone1, zone2
simulcast main-stream to all zones
stop routing main-stream
show routing status
\`\`\`

### Zone Management (Experimental)
Create logical audio zones for complex setups:
- Group multiple voice channels
- Manage multi-bot configurations
- Mix sessions across zones

\`\`\`
create zone main-stage with bot1:guild1:channel1, bot2:guild1:channel2
list zones
add bot3:guild2:channel1 to zone main-stage
remove bot1:guild1:channel1 from zone main-stage
delete zone main-stage
\`\`\`

**Note**: Routing and zone features are experimental and under active development.

## Integration with Other Music Plugins

### With @elizaos/plugin-music-library
If music-library is enabled, the player automatically:
- ✅ Tracks all played songs
- ✅ Records play counts and history
- ✅ Stores metadata for analytics
- ✅ Enables "play it again" functionality
- ✅ Builds listening statistics

### With @elizaos/plugin-radio
If radio plugin is enabled, adds:
- ✅ DJ track introductions
- ✅ Post-track commentary
- ✅ Automatic trivia segments
- ✅ Radio station mode (continuous playback)
- ✅ Time-based programming

## Configuration

### Environment Variables

**Optional:**
- \`AUDIO_CACHE_DIR\` - Audio cache location (default: \`./cache/audio\`)
- \`CROSS_FADE_DURATION\` - Fade duration in seconds (default: 3)
- \`MAX_QUEUE_SIZE\` - Maximum tracks in queue (default: 100)

### Character Settings

You can configure playback behavior in your character file:
\`\`\`json
{
  "settings": {
    "AUDIO_CACHE_DIR": "./my-cache",
    "CROSS_FADE_ENABLED": "true",
    "CROSS_FADE_DURATION": "5"
  }
}
\`\`\`

## Performance & Reliability

### Caching Strategy
- **First play**: 2-5 seconds to download and transcode
- **Cached replay**: < 100ms instant playback
- **Pre-buffering**: Next track starts downloading early
- **Smart cleanup**: Automatic cache management (7-day TTL)

### Error Handling
- **Automatic fallback** - If primary source fails, tries alternatives
- **Smart search** - Falls back to YouTube search if URL fails
- **Graceful degradation** - Continues playing even if web stream fails
- **Connection recovery** - Auto-reconnects Discord voice if dropped

### Resource Management
- **Efficient streaming** - Minimal memory footprint
- **Concurrent playback** - Multiple servers simultaneously
- **Smart buffering** - Balances latency vs stability
- **CPU optimization** - Pre-transcoding reduces real-time load

## Common Use Cases

### Basic DJ Bot
\`\`\`
User: play some Arctic Monkeys
Bot: [Searches YouTube, plays "Do I Wanna Know"]

User: queue fluorescent adolescent
Bot: ✅ Added to queue (3 tracks ahead)

User: skip
Bot: ⏭️ Skipped. Now playing: "Fluorescent Adolescent"
\`\`\`

### Web Streaming
\`\`\`html
<audio controls>
  <source src="http://localhost:3000/music-player/stream?guildId=123456789" type="audio/webm">
</audio>
\`\`\`

### Service Integration
\`\`\`typescript
const musicService = runtime.getService('music');
await musicService.addTrack(guildId, {
  url: 'https://youtube.com/watch?v=...',
  title: 'Song Title',
  requestedBy: userId,
});
\`\`\`

## Troubleshooting

### No Audio Playing
1. ✅ Check bot is in voice channel
2. ✅ Verify Discord plugin is loaded
3. ✅ Confirm bot has voice permissions
4. ✅ Check queue is not empty (\`show queue\`)

### Poor Audio Quality
1. ✅ Check internet connection
2. ✅ Clear audio cache (old transcoded files)
3. ✅ Verify yt-dlp is up to date
4. ✅ Try different source platform

### Playback Lag
1. ✅ Enable audio cache (\`AUDIO_CACHE_DIR\`)
2. ✅ Increase cache size
3. ✅ Pre-queue tracks for buffering
4. ✅ Check CPU usage during transcoding

---

Remember: The music player is the core audio engine. It handles pure playback, queuing, and streaming. For features like playlists, trivia, and DJ commentary, see \`@elizaos/plugin-radio\` and \`@elizaos/plugin-music-library\`.
`;

    return {
      text: instructions,
      data: {
        discordEnabled: !!(await runtime.getService("discord" as any)),
        musicLibraryEnabled: !!(await runtime.getService(
          "music-library" as any,
        )),
        cacheDir: runtime.getSetting("AUDIO_CACHE_DIR") || "./cache/audio",
        source: "musicPlayerInstructions",
      },
      values: {
        hasPlaybackCapabilities: true,
        supportsMultiplePlatforms: true,
        supportsCrossFade: true,
        supportsStreaming: true,
        supportsCaching: true,
        supportsBroadcast: true,
      },
    };
  },
};

export default musicPlayerInstructionsProvider;
