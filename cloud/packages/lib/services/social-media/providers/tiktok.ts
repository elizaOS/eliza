/**
 * TikTok Provider - Content Posting API
 */

import type {
  AccountAnalytics,
  MediaAttachment,
  PlatformPostOptions,
  PostAnalytics,
  PostContent,
  PostResult,
  SocialCredentials,
  SocialMediaProvider,
} from "@/lib/types/social-media";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import { withRetry } from "../rate-limit";

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

interface TikTokUser {
  open_id: string;
  union_id?: string;
  display_name: string;
  avatar_url?: string;
  follower_count?: number;
  following_count?: number;
  video_count?: number;
}

interface TikTokPublishInfo {
  publish_id: string;
  upload_url?: string;
}

interface TikTokPublishStatus {
  status:
    | "PROCESSING_UPLOAD"
    | "PROCESSING_DOWNLOAD"
    | "SEND_TO_USER_INBOX"
    | "PUBLISH_COMPLETE"
    | "FAILED";
  fail_reason?: string;
  publicaly_available_post_id?: string[];
}

async function tiktokApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${TIKTOK_API_BASE}${endpoint}`;

  const { data } = await withRetry<{
    data: T;
    error?: { code: string; message: string };
  }>(
    () =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          ...options.headers,
        },
      }),
    async (response) => {
      const json = (await response.json()) as {
        data: T;
        error?: { code: string; message: string };
      };
      if (json.error?.code && json.error.code !== "ok") {
        throw new Error(json.error.message || `TikTok error: ${json.error.code}`);
      }
      return json;
    },
    { platform: "tiktok", maxRetries: 3 },
  );

  return data.data;
}

async function waitForPublish(
  accessToken: string,
  publishId: string,
  maxWait = 300000, // 5 minutes
): Promise<TikTokPublishStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const status = await tiktokApiRequest<TikTokPublishStatus>(
      `/post/publish/status/fetch/`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({ publish_id: publishId }),
      },
    );

    if (status.status === "PUBLISH_COMPLETE") {
      return status;
    }

    if (status.status === "FAILED") {
      throw new Error(status.fail_reason || "Publish failed");
    }

    // Wait before checking again
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("Publish timeout");
}

export const tiktokProvider: SocialMediaProvider = {
  platform: "tiktok",

  async validateCredentials(credentials: SocialCredentials) {
    if (!credentials.accessToken) {
      return { valid: false, error: "Access token required" };
    }

    try {
      const user = await tiktokApiRequest<{ user: TikTokUser }>(
        "/user/info/?fields=open_id,union_id,display_name,avatar_url",
        credentials.accessToken,
      );

      return {
        valid: true,
        accountId: user.user.open_id,
        username: user.user.display_name,
        displayName: user.user.display_name,
        avatarUrl: user.user.avatar_url,
      };
    } catch (error) {
      return {
        valid: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async createPost(
    credentials: SocialCredentials,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    if (!credentials.accessToken) {
      return {
        platform: "tiktok",
        success: false,
        error: "Access token required",
      };
    }

    // TikTok requires video content
    if (!content.media?.length || content.media[0].type !== "video") {
      return {
        platform: "tiktok",
        success: false,
        error: "TikTok posts require video content",
      };
    }

    try {
      const video = content.media[0];

      logger.info("[TikTok] Creating post", { hasCaption: !!content.text });

      // Build post info
      const postInfo: Record<string, unknown> = {
        title: content.text.slice(0, 150), // TikTok caption limit
        privacy_level: options?.tiktok?.privacyLevel || "PUBLIC_TO_EVERYONE",
        disable_duet: options?.tiktok?.disableDuet || false,
        disable_comment: options?.tiktok?.disableComment || false,
        disable_stitch: options?.tiktok?.disableStitch || false,
      };

      if (options?.tiktok?.videoCoverTimestampMs) {
        postInfo.video_cover_timestamp_ms = options.tiktok.videoCoverTimestampMs;
      }

      if (options?.tiktok?.brandContentToggle) {
        postInfo.brand_content_toggle = true;
        postInfo.brand_organic_toggle = options.tiktok.brandOrganicToggle || false;
      }

      // Initialize upload from URL (pull method)
      if (video.url) {
        const initResponse = await tiktokApiRequest<TikTokPublishInfo>(
          "/post/publish/video/init/",
          credentials.accessToken,
          {
            method: "POST",
            body: JSON.stringify({
              post_info: postInfo,
              source_info: {
                source: "PULL_FROM_URL",
                video_url: video.url,
              },
            }),
          },
        );

        // Wait for publish to complete
        const status = await waitForPublish(credentials.accessToken, initResponse.publish_id);

        const postId = status.publicaly_available_post_id?.[0];

        return {
          platform: "tiktok",
          success: true,
          postId: postId || initResponse.publish_id,
          postUrl: postId ? `https://www.tiktok.com/@me/video/${postId}` : undefined,
          metadata: { publishId: initResponse.publish_id },
        };
      }

      // File upload method (requires chunked upload)
      if (video.data || video.base64) {
        const videoData = video.data || Buffer.from(video.base64!, "base64");
        const videoBody = new Uint8Array(videoData);

        // Initialize chunked upload
        const initResponse = await tiktokApiRequest<TikTokPublishInfo>(
          "/post/publish/video/init/",
          credentials.accessToken,
          {
            method: "POST",
            body: JSON.stringify({
              post_info: postInfo,
              source_info: {
                source: "FILE_UPLOAD",
                video_size: videoData.length,
                chunk_size: 10 * 1024 * 1024, // 10MB chunks
                total_chunk_count: Math.ceil(videoData.length / (10 * 1024 * 1024)),
              },
            }),
          },
        );

        if (!initResponse.upload_url) {
          throw new Error("No upload URL provided");
        }

        // Upload the video
        const uploadResponse = await fetch(initResponse.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(videoData.length),
          },
          body: videoBody,
        });

        if (!uploadResponse.ok) {
          throw new Error(`Upload failed: ${uploadResponse.status}`);
        }

        // Wait for publish to complete
        const status = await waitForPublish(credentials.accessToken, initResponse.publish_id);

        const postId = status.publicaly_available_post_id?.[0];

        return {
          platform: "tiktok",
          success: true,
          postId: postId || initResponse.publish_id,
          postUrl: postId ? `https://www.tiktok.com/@me/video/${postId}` : undefined,
        };
      }

      return {
        platform: "tiktok",
        success: false,
        error: "Video URL or data required",
      };
    } catch (error) {
      logger.error("[TikTok] Post failed", { error });
      return {
        platform: "tiktok",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async getPostAnalytics(
    credentials: SocialCredentials,
    postId: string,
  ): Promise<PostAnalytics | null> {
    if (!credentials.accessToken) {
      return null;
    }

    try {
      const response = await tiktokApiRequest<{
        videos: Array<{
          id: string;
          like_count?: number;
          comment_count?: number;
          share_count?: number;
          view_count?: number;
        }>;
      }>(
        `/video/query/?fields=id,like_count,comment_count,share_count,view_count`,
        credentials.accessToken,
        {
          method: "POST",
          body: JSON.stringify({ filters: { video_ids: [postId] } }),
        },
      );

      const video = response.videos?.[0];
      if (!video) return null;

      return {
        platform: "tiktok",
        postId,
        metrics: {
          likes: video.like_count,
          comments: video.comment_count,
          shares: video.share_count,
          videoViews: video.view_count,
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (!credentials.accessToken) {
      return null;
    }

    try {
      const user = await tiktokApiRequest<{ user: TikTokUser }>(
        "/user/info/?fields=open_id,display_name,follower_count,following_count,video_count",
        credentials.accessToken,
      );

      return {
        platform: "tiktok",
        accountId: user.user.open_id,
        metrics: {
          followers: user.user.follower_count,
          following: user.user.following_count,
          totalPosts: user.user.video_count,
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    // TikTok doesn't support pre-uploading
    // Videos are uploaded as part of the post creation
    if (media.url) {
      return { mediaId: media.url, url: media.url };
    }

    throw new Error("TikTok requires video URL for posting");
  },
};
