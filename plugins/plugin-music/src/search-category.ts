import type { IAgentRuntime, SearchCategoryRegistration } from "@elizaos/core";

export const YOUTUBE_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "youtube",
  label: "YouTube videos",
  description: "Search YouTube for music videos, songs, and general videos.",
  contexts: ["media", "knowledge"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "limit",
      label: "Limit",
      description: "Maximum videos to return.",
      type: "number",
      default: 5,
    },
    {
      name: "includeShorts",
      label: "Include Shorts",
      description: "Whether YouTube Shorts should be included.",
      type: "boolean",
      default: false,
    },
  ],
  resultSchemaSummary:
    "YouTubeSearchResult[] with url, title, duration, channel, and views.",
  capabilities: ["videos", "music", "links", "metadata"],
  source: "plugin:music-library",
  serviceType: "musicLibrary",
};

export const WIKIPEDIA_MUSIC_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "wikipedia_music",
  label: "Wikipedia music metadata",
  description:
    "Look up artist, album, and track background from Wikipedia music pages.",
  contexts: ["knowledge", "media"],
  filters: [
    { name: "query", label: "Query", type: "string", required: true },
    {
      name: "entityType",
      label: "Entity type",
      description: "Music entity type to look up.",
      type: "enum",
      options: [
        { label: "Artist", value: "artist" },
        { label: "Album", value: "album" },
        { label: "Song", value: "song" },
      ],
    },
    {
      name: "artist",
      label: "Artist",
      description: "Optional artist disambiguation for album or song lookups.",
      type: "string",
    },
  ],
  resultSchemaSummary:
    "ArtistInfo, AlbumInfo, or TrackInfo with bio/description, genres, links, images, and related artists when available.",
  capabilities: [
    "music-metadata",
    "artist-background",
    "album-info",
    "track-info",
  ],
  source: "plugin:music-library",
  serviceType: "musicLibrary",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerMusicLibrarySearchCategories(
  runtime: IAgentRuntime,
): void {
  if (!hasSearchCategory(runtime, YOUTUBE_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(YOUTUBE_SEARCH_CATEGORY);
  }
  if (!hasSearchCategory(runtime, WIKIPEDIA_MUSIC_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(WIKIPEDIA_MUSIC_SEARCH_CATEGORY);
  }
}
