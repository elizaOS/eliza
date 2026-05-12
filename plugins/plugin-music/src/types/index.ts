/**
 * Music information types
 */

export interface TrackInfo {
  title: string;
  artist: string;
  album?: string;
  duration?: number; // in seconds
  genre?: string[];
  year?: number;
  url?: string; // YouTube URL or other source
  thumbnail?: string;
  description?: string;
  tags?: string[];
  lyrics?: string; // Lyrics text or URL to lyrics
  lyricsUrl?: string; // URL to lyrics page (e.g., Genius)
}

export interface ArtistInfo {
  name: string;
  genres?: string[];
  bio?: string;
  image?: string;
  imageThumb?: string; // High-quality thumbnail from TheAudioDB
  imageLogo?: string; // Logo from TheAudioDB
  imageFanart?: string; // Fanart from TheAudioDB
  imageBanner?: string; // Banner from TheAudioDB
  similarArtists?: string[];
  albums?: string[];
  topTracks?: string[];
}

export interface AlbumInfo {
  title: string;
  artist: string;
  year?: number;
  genre?: string[];
  tracks?: string[];
  coverArt?: string;
  coverArtThumb?: string; // High-quality thumbnail from TheAudioDB
  coverArtCD?: string; // CD art from TheAudioDB
  description?: string;
}

export interface MusicInfoResult {
  track?: TrackInfo;
  artist?: ArtistInfo;
  album?: AlbumInfo;
  source:
    | "youtube"
    | "spotify"
    | "lastfm"
    | "musicbrainz"
    | "wikipedia"
    | "genius"
    | "theaudiodb";
}

// Re-export audio features types
export type {
  AudioFeatureSeed,
  AudioFeatures,
  RecommendationRequest,
  TrackRecommendation,
} from "./audioFeatures";
