/**
 * Audio features data structure for music tracks
 * Based on Spotify's audio features API
 */
export interface AudioFeatures {
  // Core identifiers
  trackId?: string;

  // Perceptual features (0.0 to 1.0)
  danceability: number; // How suitable for dancing
  energy: number; // Intensity and activity measure
  valence: number; // Musical positiveness (happy vs sad)
  acousticness: number; // Confidence track is acoustic
  instrumentalness: number; // Predicts lack of vocals
  liveness: number; // Presence of audience
  speechiness: number; // Presence of spoken words

  // Musical features
  key: number; // Estimated key (0-11, pitch class notation)
  mode: number; // Major (1) or minor (0)
  tempo: number; // Estimated tempo in BPM
  timeSignature: number; // Estimated time signature (3-7)

  // Loudness
  loudness: number; // Overall loudness in dB (-60 to 0)

  // Duration
  duration: number; // Track length in milliseconds

  // Source
  source?: "spotify" | "computed" | "manual";
}

/**
 * Simplified audio features for recommendations
 */
export interface AudioFeatureSeed {
  targetDanceability?: number;
  targetEnergy?: number;
  targetValence?: number;
  targetTempo?: number;
  targetLoudness?: number;
  targetAcousticness?: number;
  targetInstrumentalness?: number;
  targetPopularity?: number;
}

/**
 * Track recommendation request
 */
export interface RecommendationRequest {
  seedArtists?: string[]; // Up to 5 artist IDs or names
  seedTracks?: string[]; // Up to 5 track IDs or names
  seedGenres?: string[]; // Up to 5 genres
  audioFeatures?: AudioFeatureSeed;
  limit?: number; // Number of recommendations (1-100)
}

/**
 * Track recommendation result
 */
export interface TrackRecommendation {
  trackName: string;
  artistName: string;
  albumName?: string;
  url?: string;
  previewUrl?: string;
  audioFeatures?: AudioFeatures;
  popularity?: number;
}
