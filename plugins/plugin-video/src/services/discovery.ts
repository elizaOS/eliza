/** Public video metadata through the same extractor used for transcription. */
import { ElizaError } from "@elizaos/core";
import { BinaryResolver } from "./binaries";
import { parseYtDlpUploadDate } from "./video-parse";

interface ExtractorVideo {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  channel_is_verified?: boolean;
  upload_date?: string;
  timestamp?: number;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  entries?: ExtractorVideo[];
}
const normalizeName = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export async function discoverVideos(
  query: string,
  binaries = BinaryResolver.instance(),
  signal?: AbortSignal,
) {
  if (!query.trim() || query.length > 300)
    throw new ElizaError("A video search query is required.", {
      code: "VIDEO_SEARCH_QUERY_INVALID",
    });
  const result = (await binaries.runYtDlp(
    `ytsearch5:${query}`,
    { dumpSingleJson: true, flatPlaylist: true, skipDownload: true },
    signal,
  )) as ExtractorVideo;
  if (!Array.isArray(result.entries))
    throw new ElizaError("Video discovery metadata is unavailable.", {
      code: "VIDEO_DISCOVERY_UNAVAILABLE",
    });
  return result.entries
    .filter((video) => /^[A-Za-z0-9_-]{11}$/.test(video.id ?? ""))
    .map((video) => ({
      url: `https://www.youtube.com/watch?v=${video.id}`,
      title: video.title,
      creator: video.channel,
      channelId: video.channel_id,
      coverage: "Search metadata only; captions and audio have not been read.",
    }));
}

/** Date-check accessible regular uploads; search rank is not upload order. */
export async function findCreatorUpload(
  creator: string,
  binaries = BinaryResolver.instance(),
  signal?: AbortSignal,
) {
  if (!/^[A-Za-z0-9_ .-]{1,50}$/.test(creator))
    throw new ElizaError("A public creator name is required.", {
      code: "VIDEO_CREATOR_INVALID",
    });
  const channelUrl = `https://www.youtube.com/@${normalizeName(creator)}/videos`;
  const channel = (await binaries.runYtDlp(
    channelUrl,
    {
      dumpSingleJson: true,
      flatPlaylist: true,
      playlistEnd: 3,
      skipDownload: true,
    },
    signal,
  )) as ExtractorVideo;
  if (
    !channel.channel ||
    normalizeName(channel.channel) !== normalizeName(creator) ||
    channel.channel_is_verified !== true ||
    !/^UC[A-Za-z0-9_-]{22}$/.test(channel.channel_id ?? "") ||
    !Array.isArray(channel.entries)
  ) {
    throw new ElizaError(
      "A matching verified public creator channel could not be resolved.",
      { code: "VIDEO_CREATOR_UNVERIFIED" },
    );
  }
  const candidates = channel.entries.filter((video) =>
    /^[A-Za-z0-9_-]{11}$/.test(video.id ?? ""),
  );
  const checked = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const url = `https://www.youtube.com/watch?v=${candidate.id}`;
      const video = (await binaries.runYtDlp(
        url,
        { dumpSingleJson: true, skipDownload: true },
        signal,
      )) as ExtractorVideo;
      const date =
        typeof video.timestamp === "number"
          ? new Date(video.timestamp * 1000)
          : parseYtDlpUploadDate(video.upload_date);
      if (
        video.id !== candidate.id ||
        video.channel_id !== channel.channel_id ||
        video.is_live ||
        ["is_live", "is_upcoming", "post_live"].includes(
          video.live_status ?? "",
        ) ||
        !date ||
        !Number.isFinite(date.getTime()) ||
        date.getTime() > Date.now() + 300_000
      )
        return undefined;
      return {
        url,
        title: video.title,
        creator: video.channel,
        channelId: video.channel_id,
        publishedAt: date.toISOString(),
        dateAuthority:
          typeof video.timestamp === "number"
            ? "Extractor-reported publication timestamp."
            : "Extractor-reported upload calendar date; time is unspecified.",
        durationSeconds: video.duration,
      };
    }),
  );
  signal?.throwIfAborted();
  const videos = checked
    .flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  if (!videos.length)
    throw new ElizaError(
      "No dated accessible regular upload could be verified.",
      { code: "VIDEO_CREATOR_UPLOAD_UNAVAILABLE" },
    );
  return {
    ...videos[0],
    channelUrl,
    checkedUploads: videos.length,
    coverage:
      "Newest dated accessible candidate from the verified channel Videos tab. The bounded public view can miss unavailable uploads; no global-latest guarantee. Metadata only until a transcript is read.",
  };
}
