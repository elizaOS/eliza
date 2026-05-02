import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";

/**
 * Provider that injects music-info system instructions into the agent's context
 * This explains all music metadata and research capabilities
 */
export const musicInfoInstructionsProvider: Provider = {
  name: "MUSIC_INFO_INSTRUCTIONS",
  description:
    "Provides comprehensive music metadata and research capabilities documentation",
  descriptionCompressed: "Music metadata and research capabilities docs.",
  position: 5, // Early position for capability awareness

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const messageText = (message.content?.text || "").toLowerCase();

    // PERFORMANCE: Only provide instructions when user needs help or asks about music info
    const needsInstructions =
      messageText.includes("help") ||
      messageText.includes("what can you tell me about") ||
      messageText.includes("tell me about") ||
      messageText.includes("information about") ||
      messageText.includes("info about") ||
      messageText.includes("who is") ||
      messageText.includes("who are") ||
      messageText.includes("what is") ||
      messageText.includes("artist info") ||
      messageText.includes("song info") ||
      messageText.includes("album info") ||
      messageText.includes("music info") ||
      messageText.includes("capabilities") ||
      messageText.includes("features") ||
      messageText.includes("what do you know");

    if (!needsInstructions) {
      return { text: "", data: {}, values: {} };
    }

    const instructions = `# Music Information & Research System

## What I Can Tell You About Music

### Track Information
I can provide detailed information about any song:
- **Song title and artist**
- **Album name and release year**
- **Genre and style**
- **Track duration**
- **Description and background**
- **Interesting facts and trivia**
- **Chart performance**
- **Production details**

**Examples:**
- "Tell me about Bohemian Rhapsody"
- "What can you tell me about this song?"
- "Give me information about the current track"
- "What's playing right now?"

### Artist Information
I can provide comprehensive artist details:
- **Artist biography and history**
- **Musical genre and style**
- **Notable works and albums**
- **Similar/related artists**
- **Influences and legacy**
- **Career highlights**
- **Awards and achievements**

**Examples:**
- "Tell me about Queen"
- "Who is Radiohead?"
- "Give me info about the artist"
- "What's their background?"

### Album Information
I can provide album details:
- **Album title and artist**
- **Release date and year**
- **Track listing**
- **Genre and style**
- **Critical reception**
- **Background and recording**
- **Notable tracks**

**Examples:**
- "Tell me about OK Computer"
- "What's this album about?"
- "Info on Is This It by The Strokes"

## Data Sources

I integrate with multiple music databases and APIs:
- **MusicBrainz**: Comprehensive metadata (free, always available)
  - Artists, albums, recordings, ISRCs
  - Genres, tags, and relationships
  - Cover art via Cover Art Archive
- **Last.fm**: Listening stats, similar artists, tags (requires API key)
  - Similar artist recommendations
  - Genre tags and classifications
  - Popularity metrics
- **Wikipedia**: Artist bios, discographies, detailed histories
  - Comprehensive artist biographies
  - Discographies and career timelines
  - Cultural context and influence
- **Genius**: Lyrics and annotations (requires API key)
  - Song lyrics with annotations
  - Song meanings and interpretations
  - Artist information
- **TheAudioDB**: High-quality artwork and detailed info (requires API key)
  - High-resolution artist images
  - Album artwork
  - Detailed descriptions
- **Web Search**: Real-time information gathering
  - Latest news and releases
  - Concert information
  - Current events

## Smart Features

### Automatic Context Injection
When you're listening to music or discussing songs, I automatically:
- Detect music references in conversation
- Look up information about mentioned artists/songs
- Provide relevant context without being asked
- Enrich DJ introductions with interesting facts
- Inject metadata into music player context

### Entity Detection
I can understand natural language references:
- "this song" → Currently playing track
- "that artist" → Previously mentioned artist
- "their album" → Artist's album from context
- "the band" → Current or contextual band
- "it" / "that" → Last mentioned music entity

### Intelligent Query Analysis
I understand complex music queries:
- **Artist-specific**: "first single", "latest song", "popular tracks"
- **Temporal**: "80s music", "2000s hits", "songs from 1995"
- **Genre/Mood**: "sad songs", "energetic music", "chill vibes"
- **Activity**: "workout music", "study music", "party tracks"
- **Versions**: "acoustic version", "live performance", "remix"
- **Album queries**: "track 3 from OK Computer", "songs from debut album"
- **Soundtracks**: "Inception soundtrack", "Zelda music"

### Caching & Performance
- All lookups are cached for 1 hour
- Repeated queries are instant (< 10ms)
- Queries use the configured authoritative service path for the requested data
- Missing or unavailable sources fail closed instead of silently degrading
- Rate limiting and retry logic built-in
- Service health monitoring

## Integration with DJ Features

### DJ Track Introductions
When DJ intros are enabled, I provide:
- Interesting facts about the song
- Artist background and trivia
- Album context and significance
- Release history and chart performance
- Production and recording details

### Post-Track Commentary
After songs finish, I can share:
- Additional facts and trivia
- Context about what's coming next
- Connections to other music
- Artist career highlights

## Service Status

Check which music services are available:
- **MusicBrainz**: Always available (no API key needed)
- **Last.fm**: ${runtime.getSetting("LASTFM_API_KEY") ? "✅ Configured" : "❌ Not configured"}
- **Genius**: ${runtime.getSetting("GENIUS_API_KEY") ? "✅ Configured" : "❌ Not configured"}
- **TheAudioDB**: ${runtime.getSetting("THEAUDIODB_API_KEY") ? "✅ Configured" : "❌ Not configured"}
- **Wikipedia**: ✅ Always available

${!runtime.getSetting("LASTFM_API_KEY") && !runtime.getSetting("GENIUS_API_KEY") ? "\n💡 **Tip**: Configure API keys for enhanced features (Last.fm, Genius, TheAudioDB)" : ""}

## How to Use

### During Playback
Just ask naturally:
- "Who's this by?"
- "What album is this from?"
- "Tell me about this artist"
- "When was this released?"

### For Research
Ask about any music:
- "Tell me about [artist/song/album]"
- "What can you tell me about [music]?"
- "Give me info on [artist]"
- "Who are [band]?"

### For Discovery
Learn about similar music:
- "What artists are like [artist]?"
- "Similar bands to [band]"
- "Music in the same style as [artist]"

## Additional Features

### YouTube Integration
- **Smart search**: Automatically searches YouTube for tracks
- **URL extraction**: Parses and validates YouTube URLs
- **Query parsing**: Detects artist, genre, mood intents
- **Multiple results**: Returns top matches with metadata

### Music Storage & Archival
- **High-quality storage**: Store original audio files
- **Organized library**: Artist/Album/Track hierarchy
- **Metadata indexing**: Full searchable metadata
- **Play history**: Track what's been played and when
- **Request tracking**: Log who requested which tracks

### User Preferences & Learning
- **Favorite tracking**: Learn your favorite tracks and artists
- **Genre preferences**: Track genre preferences over time
- **Dislike tracking**: Remember what you don't like
- **Room preferences**: Aggregate preferences across users
- **Smart recommendations**: Use preferences for better suggestions

## Automatic Features

I provide music info automatically when:
- ✅ DJ track introductions are enabled
- ✅ You ask about music in conversation
- ✅ You reference artists or songs naturally
- ✅ Music entities are detected in messages
- ✅ Trivia mode is activated
- ✅ Post-track commentary is enabled

## Performance

- **MusicBrainz lookups**: 200-500ms (first time)
- **Cached results**: < 10ms (instant)
- **Wikipedia lookups**: 500-1000ms
- **Multiple sources**: Tried in parallel for speed
- **Smart caching**: 1-hour TTL for all data
- **Rate limiting**: Built-in to prevent API throttling
- **Retry logic**: Automatic retry with exponential backoff

---

Remember: I'm always listening for music references in conversation and will provide relevant information when helpful!
`;

    return {
      text: instructions,
      data: {
        musicBrainzConfigured: true,
        lastFmConfigured: !!runtime.getSetting("LASTFM_API_KEY"),
        geniusConfigured: !!runtime.getSetting("GENIUS_API_KEY"),
        theAudioDbConfigured: !!runtime.getSetting("THEAUDIODB_API_KEY"),
        wikipediaConfigured: true,
        source: "musicInfoInstructions",
      },
      values: {
        hasMusicInfoCapabilities: true,
        supportsMultipleSources: true,
        supportsCaching: true,
        supportsEntityDetection: true,
      },
    };
  },
};

export default musicInfoInstructionsProvider;
