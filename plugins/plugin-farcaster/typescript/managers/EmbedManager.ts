import { type IAgentRuntime, type Media, ModelType } from "@elizaos/core";
import type { EmbedCast, EmbedUrl, Embed as NeynarEmbed } from "@neynar/nodejs-sdk/build/api";

export function isEmbedUrl(embed: NeynarEmbed): embed is EmbedUrl {
  return "url" in embed && typeof (embed as EmbedUrl).url === "string";
}

export function isEmbedCast(embed: NeynarEmbed): embed is EmbedCast {
  return "cast" in embed && typeof (embed as EmbedCast).cast === "object";
}

function getMediaTypeFromUrl(
  url: string,
  contentType?: string | null
): "image" | "video" | "audio" | "webpage" | "unknown" {
  const lowerUrl = url.toLowerCase();
  const lowerContentType = contentType?.toLowerCase() || "";

  if (lowerContentType.startsWith("image/")) return "image";
  if (lowerContentType.startsWith("video/")) return "video";
  if (lowerContentType.startsWith("audio/")) return "audio";

  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico"];
  const videoExtensions = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"];
  const audioExtensions = [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"];

  if (imageExtensions.some((ext) => lowerUrl.includes(ext))) return "image";
  if (videoExtensions.some((ext) => lowerUrl.includes(ext))) return "video";
  if (audioExtensions.some((ext) => lowerUrl.includes(ext))) return "audio";

  return "webpage";
}

export interface ProcessedEmbed {
  id: string;
  url: string;
  type: "image" | "video" | "audio" | "webpage" | "cast" | "frame" | "unknown";
  title?: string;
  description?: string;
  text?: string;
  source: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    contentType?: string;
    castHash?: string;
    authorFid?: number;
    authorUsername?: string;
  };
}

export class EmbedManager {
  private runtime: IAgentRuntime;
  private embedCache: Map<string, ProcessedEmbed> = new Map();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  async processEmbeds(embeds: NeynarEmbed[]): Promise<Media[]> {
    if (embeds.length === 0) {
      return [];
    }

    this.runtime.logger.info(
      { embedCount: embeds.length },
      "[EmbedManager] Processing embeds from cast"
    );

    const processedMedia: Media[] = [];

    for (const embed of embeds) {
      try {
        const processed = await this.processEmbed(embed);
        if (processed) {
          processedMedia.push(this.toMedia(processed));
        }
      } catch (error) {
        this.runtime.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[EmbedManager] Failed to process embed"
        );
      }
    }

    this.runtime.logger.info(
      {
        processedCount: processedMedia.length,
        types: processedMedia.map((m) => m.source),
      },
      "[EmbedManager] Finished processing embeds"
    );

    return processedMedia;
  }

  async processEmbed(embed: NeynarEmbed): Promise<ProcessedEmbed | null> {
    if (isEmbedUrl(embed)) {
      return this.processUrlEmbed(embed);
    } else if (isEmbedCast(embed)) {
      return this.processCastEmbed(embed);
    }

    this.runtime.logger.debug("[EmbedManager] Unknown embed type");
    return null;
  }

  private async processUrlEmbed(embed: EmbedUrl): Promise<ProcessedEmbed> {
    const { url, metadata } = embed;
    const embedId = `embed-${this.hashUrl(url)}`;

    const cached = this.embedCache.get(embedId);
    if (cached) {
      return cached;
    }

    const contentType = metadata?.content_type;
    const mediaType = getMediaTypeFromUrl(url, contentType);

    if (metadata?.frame) {
      return this.processFrameEmbed(embed, embedId);
    }

    let processed: ProcessedEmbed;

    switch (mediaType) {
      case "image":
        processed = await this.processImageEmbed(embed, embedId);
        break;
      case "video":
        processed = await this.processVideoEmbed(embed, embedId);
        break;
      case "audio":
        processed = await this.processAudioEmbed(embed, embedId);
        break;
      default:
        processed = await this.processWebpageEmbed(embed, embedId);
    }

    this.embedCache.set(embedId, processed);
    return processed;
  }

  private async processImageEmbed(embed: EmbedUrl, embedId: string): Promise<ProcessedEmbed> {
    const { url, metadata } = embed;

    let description = "An image attachment";
    let title = "Image";

    try {
      const result = await this.runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
        prompt:
          "Analyze this image and provide a concise title and description. Focus on the main subject and any notable details.",
        imageUrl: url,
      });

      if (result && typeof result === "object") {
        const typedResult = result as { title?: string; description?: string };
        description = typedResult.description || description;
        title = typedResult.title || title;
      } else if (typeof result === "string") {
        description = result;
      }

      this.runtime.logger.info(
        {
          url: `${url.substring(0, 60)}...`,
          descriptionLength: description.length,
          title,
        },
        "[EmbedManager] Processed image with vision model"
      );
    } catch (error) {
      this.runtime.logger.warn(
        { url, error: error instanceof Error ? error.message : String(error) },
        "[EmbedManager] Failed to describe image, using fallback"
      );
    }

    return {
      id: embedId,
      url,
      type: "image",
      title,
      description,
      text: description,
      source: "Farcaster",
      metadata: {
        width: metadata?.image?.width_px,
        height: metadata?.image?.height_px,
        contentType: metadata?.content_type || "image/*",
      },
    };
  }

  private async processVideoEmbed(embed: EmbedUrl, embedId: string): Promise<ProcessedEmbed> {
    const { url, metadata } = embed;

    const description = metadata?.video?.duration_s
      ? `Video (${Math.round(metadata.video.duration_s)}s)`
      : "Video attachment";

    return {
      id: embedId,
      url,
      type: "video",
      title: "Video",
      description,
      text: description,
      source: "Farcaster",
      metadata: {
        duration: metadata?.video?.duration_s,
        contentType: metadata?.content_type || "video/*",
      },
    };
  }

  private async processAudioEmbed(embed: EmbedUrl, embedId: string): Promise<ProcessedEmbed> {
    const { url, metadata } = embed;

    const description = "Audio attachment";

    return {
      id: embedId,
      url,
      type: "audio",
      title: "Audio",
      description,
      text: description,
      source: "Farcaster",
      metadata: {
        contentType: metadata?.content_type || "audio/*",
      },
    };
  }

  private async processWebpageEmbed(embed: EmbedUrl, embedId: string): Promise<ProcessedEmbed> {
    const { url, metadata } = embed;
    const html = metadata?.html;

    const title = html?.ogTitle || html?.ogSiteName || "Web Page";
    const hostnameMatch = url.match(/^(?:https?:\/\/)?([^/?#]+)/);
    const hostname = hostnameMatch ? hostnameMatch[1] : url;
    const description = html?.ogDescription || `Link to ${hostname}`;

    return {
      id: embedId,
      url,
      type: "webpage",
      title,
      description,
      text: `${title}: ${description}`,
      source: "Web",
      metadata: {
        contentType: "text/html",
      },
    };
  }

  private async processFrameEmbed(embed: EmbedUrl, embedId: string): Promise<ProcessedEmbed> {
    const { url, metadata } = embed;
    const frame = metadata?.frame;

    const title = frame?.title || "Farcaster Frame";
    const description = `Interactive Frame: ${title}`;

    return {
      id: embedId,
      url,
      type: "frame",
      title,
      description,
      text: description,
      source: "Frame",
      metadata: {
        contentType: "application/x-farcaster-frame",
      },
    };
  }

  private async processCastEmbed(embed: EmbedCast): Promise<ProcessedEmbed> {
    const cast = embed.cast;
    const embedId = `cast-${cast.hash}`;

    const cached = this.embedCache.get(embedId);
    if (cached) {
      return cached;
    }

    const authorUsername = cast.author?.username || "unknown";
    const title = `Quoted cast from @${authorUsername}`;
    const description = cast.text || "";

    const processed: ProcessedEmbed = {
      id: embedId,
      url: `https://warpcast.com/${authorUsername}/${cast.hash.slice(0, 10)}`,
      type: "cast",
      title,
      description,
      text: `[Quote from @${authorUsername}]: ${description}`,
      source: "Farcaster",
      metadata: {
        castHash: cast.hash,
        authorFid: cast.author?.fid,
        authorUsername,
      },
    };

    this.embedCache.set(embedId, processed);
    return processed;
  }

  private toMedia(embed: ProcessedEmbed): Media {
    return {
      id: embed.id,
      url: embed.url,
      title: embed.title || embed.type,
      source: embed.source,
      description: embed.description,
      text: embed.text,
    };
  }

  private hashUrl(url: string): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  clearCache(): void {
    this.embedCache.clear();
  }
}
