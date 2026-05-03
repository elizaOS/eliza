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
import { TWITTER_API_BASE, TWITTER_UPLOAD_BASE } from "@/lib/utils/twitter-api";
import { withRetry } from "../rate-limit";

// Wrapped with retry logic for social media provider
async function twitterApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${TWITTER_API_BASE}${endpoint}`;
  const { data } = await withRetry<T>(
    () =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }),
    async (response) => response.json(),
    { platform: "twitter", maxRetries: 3 },
  );
  return data;
}

async function uploadMedia(accessToken: string, media: MediaAttachment): Promise<string> {
  let mediaData: Buffer;
  if (media.data) {
    mediaData = media.data;
  } else if (media.base64) {
    mediaData = Buffer.from(media.base64, "base64");
  } else if (media.url) {
    const response = await fetch(media.url);
    mediaData = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("No media data provided");
  }

  const mediaType = media.type === "video" ? "tweet_video" : "tweet_image";

  if (media.type === "image" && mediaData.length < 5 * 1024 * 1024) {
    const formData = new URLSearchParams();
    formData.append("media_data", mediaData.toString("base64"));
    formData.append("media_category", mediaType);

    const response = await fetch(`${TWITTER_UPLOAD_BASE}/media/upload.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Media upload failed: ${response.status}`);
    }

    const data = (await response.json()) as { media_id_string: string };
    return data.media_id_string;
  }

  // Chunked upload for videos/large images
  const initParams = new URLSearchParams({
    command: "INIT",
    total_bytes: String(mediaData.length),
    media_type: media.mimeType,
    media_category: mediaType,
  });

  const initResponse = await fetch(`${TWITTER_UPLOAD_BASE}/media/upload.json?${initParams}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!initResponse.ok) {
    throw new Error("Media upload INIT failed");
  }

  const initData = (await initResponse.json()) as { media_id_string: string };
  const mediaId = initData.media_id_string;

  const chunkSize = 5 * 1024 * 1024;
  let segmentIndex = 0;
  for (let offset = 0; offset < mediaData.length; offset += chunkSize) {
    const chunk = mediaData.subarray(offset, offset + chunkSize);
    const appendParams = new URLSearchParams({
      command: "APPEND",
      media_id: mediaId,
      segment_index: String(segmentIndex),
    });

    const formData = new FormData();
    const chunkBytes = Uint8Array.from(chunk);
    formData.append("media", new Blob([chunkBytes]));

    const appendResponse = await fetch(`${TWITTER_UPLOAD_BASE}/media/upload.json?${appendParams}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });

    if (!appendResponse.ok) {
      throw new Error(`Media upload APPEND failed at segment ${segmentIndex}`);
    }
    segmentIndex++;
  }

  const finalizeParams = new URLSearchParams({
    command: "FINALIZE",
    media_id: mediaId,
  });

  const finalizeResponse = await fetch(
    `${TWITTER_UPLOAD_BASE}/media/upload.json?${finalizeParams}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!finalizeResponse.ok) {
    throw new Error("Media upload FINALIZE failed");
  }

  const finalizeData = (await finalizeResponse.json()) as { processing_info?: unknown };

  if (finalizeData.processing_info) {
    await waitForProcessing(accessToken, mediaId);
  }

  return mediaId;
}

async function waitForProcessing(
  accessToken: string,
  mediaId: string,
  maxWait = 60000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const statusParams = new URLSearchParams({
      command: "STATUS",
      media_id: mediaId,
    });

    const response = await fetch(`${TWITTER_UPLOAD_BASE}/media/upload.json?${statusParams}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await response.json()) as {
      processing_info?: {
        state: string;
        check_after_secs?: number;
        error?: { message?: string };
      };
    };

    if (!data.processing_info) {
      return; // Processing complete
    }

    if (data.processing_info.state === "failed") {
      throw new Error(
        `Media processing failed: ${data.processing_info.error?.message || "Unknown error"}`,
      );
    }

    const waitTime = (data.processing_info.check_after_secs || 5) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }

  throw new Error("Media processing timeout");
}

export const twitterProvider: SocialMediaProvider = {
  platform: "twitter",

  async validateCredentials(credentials: SocialCredentials) {
    if (!credentials.accessToken) {
      return { valid: false, error: "Access token required" };
    }

    try {
      const response = await twitterApiRequest<{
        data: {
          id: string;
          username: string;
          name: string;
          profile_image_url?: string;
        };
      }>("/users/me?user.fields=profile_image_url", credentials.accessToken);

      return {
        valid: true,
        accountId: response.data.id,
        username: response.data.username,
        displayName: response.data.name,
        avatarUrl: response.data.profile_image_url,
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
        platform: "twitter",
        success: false,
        error: "Access token required",
      };
    }

    try {
      const payload: Record<string, unknown> = { text: content.text };

      if (content.media?.length) {
        const mediaIds: string[] = [];
        for (const media of content.media) {
          const mediaId = await uploadMedia(credentials.accessToken, media);
          mediaIds.push(mediaId);
        }
        payload.media = { media_ids: mediaIds };
      }

      if (content.replyToId) payload.reply = { in_reply_to_tweet_id: content.replyToId };
      if (options?.twitter?.quoteTweetId) payload.quote_tweet_id = options.twitter.quoteTweetId;
      if (options?.twitter?.replySettings) payload.reply_settings = options.twitter.replySettings;
      if (options?.twitter?.pollOptions?.length) {
        payload.poll = {
          options: options.twitter.pollOptions.map((opt) => ({ label: opt })),
          duration_minutes: options.twitter.pollDurationMinutes || 1440,
        };
      }

      logger.info("[Twitter] Creating post", {
        hasMedia: !!content.media?.length,
      });

      const response = await twitterApiRequest<{
        data: { id: string; text: string };
      }>("/tweets", credentials.accessToken, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      return {
        platform: "twitter",
        success: true,
        postId: response.data.id,
        postUrl: `https://twitter.com/i/status/${response.data.id}`,
      };
    } catch (error) {
      logger.error("[Twitter] Post failed", { error });
      return {
        platform: "twitter",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    try {
      await twitterApiRequest(`/tweets/${postId}`, credentials.accessToken, {
        method: "DELETE",
      });

      return { success: true };
    } catch (error) {
      return {
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
      const response = await twitterApiRequest<{
        data: {
          public_metrics: {
            like_count: number;
            retweet_count: number;
            reply_count: number;
            quote_count: number;
            impression_count?: number;
          };
        };
      }>(`/tweets/${postId}?tweet.fields=public_metrics`, credentials.accessToken);

      const metrics = response.data.public_metrics;

      return {
        platform: "twitter",
        postId,
        metrics: {
          likes: metrics.like_count,
          reposts: metrics.retweet_count,
          comments: metrics.reply_count,
          shares: metrics.quote_count,
          impressions: metrics.impression_count,
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
      const response = await twitterApiRequest<{
        data: {
          id: string;
          public_metrics: {
            followers_count: number;
            following_count: number;
            tweet_count: number;
          };
        };
      }>("/users/me?user.fields=public_metrics", credentials.accessToken);

      const metrics = response.data.public_metrics;

      return {
        platform: "twitter",
        accountId: response.data.id,
        metrics: {
          followers: metrics.followers_count,
          following: metrics.following_count,
          totalPosts: metrics.tweet_count,
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    if (!credentials.accessToken) {
      throw new Error("Access token required");
    }

    const mediaId = await uploadMedia(credentials.accessToken, media);
    return { mediaId };
  },

  async replyToPost(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    return this.createPost(credentials, { ...content, replyToId: postId }, options);
  },

  async likePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) return { success: false, error: "Access token required" };

    try {
      const userResponse = await twitterApiRequest<{ data: { id: string } }>(
        "/users/me",
        credentials.accessToken,
      );
      await twitterApiRequest(`/users/${userResponse.data.id}/likes`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({ tweet_id: postId }),
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: extractErrorMessage(error) };
    }
  },

  async repost(credentials: SocialCredentials, postId: string): Promise<PostResult> {
    if (!credentials.accessToken)
      return {
        platform: "twitter",
        success: false,
        error: "Access token required",
      };

    try {
      const userResponse = await twitterApiRequest<{ data: { id: string } }>(
        "/users/me",
        credentials.accessToken,
      );
      await twitterApiRequest(`/users/${userResponse.data.id}/retweets`, credentials.accessToken, {
        method: "POST",
        body: JSON.stringify({ tweet_id: postId }),
      });
      return { platform: "twitter", success: true, postId };
    } catch (error) {
      return {
        platform: "twitter",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
