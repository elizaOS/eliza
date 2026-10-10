import {
  type Action,
  ElizaError,
  fetchRemoteMedia,
  ServiceType,
} from "@elizaos/core";
import { discoverVideos, findCreatorUpload } from "./services/discovery";
import type { VideoService } from "./services/video";

export const discoverMediaAction: Action = {
  name: "DISCOVER_MEDIA",
  similes: ["SEARCH_VIDEOS", "SEARCH_PODCASTS"],
  tags: ["resource:media", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Find public YouTube videos or podcast feeds. Returns catalog metadata, not transcript evidence.",
  parameters: [
    {
      name: "query",
      description: "Public media search topic.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "kind",
      description: "Media catalog to search.",
      required: true,
      schema: { type: "string", enum: ["youtube", "podcast"] },
    },
  ],
  validate: async () => true,
  handler: async (_runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    if (
      typeof params?.query !== "string" ||
      !params.query.trim() ||
      params.query.length > 300 ||
      !["youtube", "podcast"].includes(String(params.kind))
    )
      throw new ElizaError("A media topic and catalog are required.", {
        code: "MEDIA_DISCOVERY_PARAMETERS_INVALID",
      });
    let items: Array<{
      url: string;
      title?: string;
      creator?: string;
      coverage: string;
      channelId?: string;
    }>;
    if (params.kind === "youtube")
      items = await discoverVideos(
        params.query,
        undefined,
        options?.abortSignal instanceof AbortSignal
          ? options.abortSignal
          : undefined,
      );
    else {
      const url = new URL("https://itunes.apple.com/search");
      url.search = new URLSearchParams({
        media: "podcast",
        entity: "podcast",
        limit: "5",
        term: params.query,
      }).toString();
      const { buffer } = await fetchRemoteMedia({
        url: url.toString(),
        maxBytes: 1_000_000,
        signal:
          options?.abortSignal instanceof AbortSignal
            ? options.abortSignal
            : undefined,
      });
      const catalog = JSON.parse(buffer.toString("utf8")) as {
        results?: Array<{
          feedUrl?: string;
          collectionName?: string;
          artistName?: string;
        }>;
      };
      if (!Array.isArray(catalog.results))
        throw new ElizaError("The public podcast catalog is unavailable.", {
          code: "PODCAST_CATALOG_UNAVAILABLE",
        });
      items = catalog.results.flatMap((item) =>
        typeof item.feedUrl === "string" && item.feedUrl.startsWith("https://")
          ? [
              {
                url: item.feedUrl,
                title: item.collectionName,
                creator: item.artistName,
                coverage:
                  "Podcast catalog metadata only; feed audio has not been transcribed.",
              },
            ]
          : [],
      );
    }
    return {
      success: true,
      text: JSON.stringify(items),
      modelReplyRequired: true,
      data: {
        actionName: "DISCOVER_MEDIA",
        items,
        sources: items.map((item) => ({
          url: item.url,
          text: JSON.stringify(item),
        })),
      },
    };
  },
};

export const creatorUploadAction: Action = {
  name: "FIND_CREATOR_UPLOAD",
  similes: ["LATEST_CREATOR_VIDEO"],
  tags: ["resource:video", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Find the newest dated accessible regular upload among candidates from a matching verified public YouTube channel. Returns metadata; restricted uploads may be missing.",
  parameters: [
    {
      name: "creator",
      description: "Public creator name or handle.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (_runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    if (typeof params?.creator !== "string")
      throw new ElizaError("A creator name is required.", {
        code: "VIDEO_CREATOR_REQUIRED",
      });
    const video = await findCreatorUpload(
      params.creator,
      undefined,
      options?.abortSignal instanceof AbortSignal
        ? options.abortSignal
        : undefined,
    );
    const text = JSON.stringify(video);
    return {
      success: true,
      text,
      modelReplyRequired: true,
      data: {
        actionName: "FIND_CREATOR_UPLOAD",
        video,
        sources: [{ url: video.url, text }],
      },
    };
  },
};

export const readVideoTranscriptAction: Action = {
  name: "READ_VIDEO_TRANSCRIPT",
  similes: ["TRANSCRIBE_VIDEO"],
  tags: ["resource:video", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Read video captions or transcribe audio through the registered video service. Returns the complete transcript; this does not inspect visuals or claim a job is complete before processing succeeds.",
  parameters: [
    {
      name: "url",
      description: "Video URL to process.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    if (typeof params?.url !== "string")
      throw new ElizaError("A video URL is required.", {
        code: "VIDEO_URL_REQUIRED",
      });
    const url = new URL(params.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["www.youtube.com", "youtube.com", "youtu.be"].includes(url.hostname)
    ) {
      throw new ElizaError("A public YouTube video URL is required.", {
        code: "VIDEO_URL_INVALID",
      });
    }
    if (options?.abortSignal instanceof AbortSignal)
      options.abortSignal.throwIfAborted();
    const service = runtime.getService<VideoService>(ServiceType.VIDEO);
    if (!service)
      throw new ElizaError("The video service is unavailable.", {
        code: "VIDEO_SERVICE_UNAVAILABLE",
      });
    const video = await service.processVideo(url.toString(), runtime);
    if (
      !video.text?.trim() ||
      ["No lyrics available.", "Transcription failed"].includes(video.text)
    ) {
      throw new ElizaError("The video source has no completed transcript.", {
        code: "MEDIA_TRANSCRIPT_UNAVAILABLE",
      });
    }
    if (options?.abortSignal instanceof AbortSignal)
      options.abortSignal.throwIfAborted();
    return {
      success: true,
      text: JSON.stringify(video),
      modelReplyRequired: true,
      data: {
        actionName: "READ_VIDEO_TRANSCRIPT",
        video,
        sources: [{ url: url.toString(), text: video.text }],
        coverage:
          "Completed captions or audio transcript; no visual inspection.",
      },
    };
  },
};
