import type { IAgentRuntime, UUID } from "@elizaos/core";

export type MusicFetchProgress = {
  stage?: string;
  message?: string;
  details?: unknown;
};

export type MusicFetchResult = {
  success: boolean;
  source: "library" | "ytdlp" | "torrent";
  url?: string;
  title?: string;
  duration?: number;
  error?: string;
};

type PreferredQuality = "flac" | "mp3_320" | "any";

export interface SmartMusicFetchServiceLike {
  fetchMusic(options: {
    query: string;
    requestedBy?: UUID;
    onProgress?: (progress: MusicFetchProgress) => Promise<void> | void;
    preferredQuality?: PreferredQuality;
  }): Promise<MusicFetchResult>;
}

export function getSmartMusicFetchService(
  runtime: IAgentRuntime,
): SmartMusicFetchServiceLike {
  const service = runtime.getService(
    "smart-music-fetch",
  ) as SmartMusicFetchServiceLike | null;

  if (!service) {
    throw new Error("Smart music fetch service is not available");
  }

  return service;
}
