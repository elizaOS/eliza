/**
 * Meta Provider - Facebook & Instagram via Graph API
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

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

interface GraphApiError {
  error?: { message: string; code: number; type: string };
}

interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
}

interface FacebookPost {
  id: string;
}

interface InstagramAccount {
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
}

interface InstagramMediaContainer {
  id: string;
}

async function graphApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = new URL(endpoint.startsWith("http") ? endpoint : `${GRAPH_API_BASE}${endpoint}`);
  if (options.method === "GET") {
    url.searchParams.set("access_token", accessToken);
  }

  const { data } = await withRetry<T>(
    () =>
      fetch(url.toString(), {
        ...options,
        headers: { "Content-Type": "application/json", ...options.headers },
      }),
    async (response) => {
      const json = (await response.json()) as T;
      if ((json as GraphApiError).error) throw new Error((json as GraphApiError).error!.message);
      return json;
    },
    { platform: "facebook", maxRetries: 3 },
  );

  return data;
}

// FACEBOOK METHODS

async function createFacebookPost(
  credentials: SocialCredentials,
  content: PostContent,
  options?: PlatformPostOptions,
): Promise<PostResult> {
  const pageId = options?.facebook?.pageId || credentials.pageId;

  if (!pageId) {
    return { platform: "facebook", success: false, error: "Page ID required" };
  }

  if (!credentials.accessToken) {
    return {
      platform: "facebook",
      success: false,
      error: "Access token required",
    };
  }

  try {
    logger.info("[Facebook] Creating post", {
      pageId,
      hasMedia: !!content.media?.length,
      hasLink: !!content.link,
    });

    let postData: FacebookPost;

    // Photo post
    if (content.media?.length && content.media[0].type === "image") {
      const media = content.media[0];
      const params: Record<string, string> = {
        access_token: credentials.accessToken,
        caption: content.text,
      };

      if (media.url) {
        params.url = media.url;
      }

      const searchParams = new URLSearchParams(params);
      postData = await graphApiRequest<FacebookPost>(
        `/${pageId}/photos?${searchParams}`,
        credentials.accessToken,
        { method: "POST" },
      );
    }
    // Video post
    else if (content.media?.length && content.media[0].type === "video") {
      const media = content.media[0];
      const params: Record<string, string> = {
        access_token: credentials.accessToken,
        description: content.text,
      };

      if (media.url) {
        params.file_url = media.url;
      }

      const searchParams = new URLSearchParams(params);
      postData = await graphApiRequest<FacebookPost>(
        `/${pageId}/videos?${searchParams}`,
        credentials.accessToken,
        { method: "POST" },
      );
    }
    // Link post
    else if (content.link) {
      const params = new URLSearchParams({
        access_token: credentials.accessToken,
        message: content.text,
        link: content.link,
      });

      postData = await graphApiRequest<FacebookPost>(
        `/${pageId}/feed?${params}`,
        credentials.accessToken,
        { method: "POST" },
      );
    }
    // Text post
    else {
      const params = new URLSearchParams({
        access_token: credentials.accessToken,
        message: content.text,
      });

      postData = await graphApiRequest<FacebookPost>(
        `/${pageId}/feed?${params}`,
        credentials.accessToken,
        { method: "POST" },
      );
    }

    return {
      platform: "facebook",
      success: true,
      postId: postData.id,
      postUrl: `https://facebook.com/${postData.id}`,
    };
  } catch (error) {
    logger.error("[Facebook] Post failed", { error });
    return {
      platform: "facebook",
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

// INSTAGRAM METHODS

async function createInstagramPost(
  credentials: SocialCredentials,
  content: PostContent,
  options?: PlatformPostOptions,
): Promise<PostResult> {
  const accountId = options?.instagram?.accountId || credentials.accountId;

  if (!accountId) {
    return {
      platform: "instagram",
      success: false,
      error: "Instagram account ID required",
    };
  }

  if (!credentials.accessToken) {
    return {
      platform: "instagram",
      success: false,
      error: "Access token required",
    };
  }

  // Instagram requires at least one image
  if (!content.media?.length || content.media[0].type !== "image") {
    return {
      platform: "instagram",
      success: false,
      error: "Instagram posts require at least one image",
    };
  }

  try {
    logger.info("[Instagram] Creating post", {
      accountId,
      mediaCount: content.media.length,
    });

    // Single image or video
    if (content.media.length === 1) {
      const media = content.media[0];

      // Step 1: Create media container
      const containerParams: Record<string, string> = {
        access_token: credentials.accessToken,
        caption: content.text,
      };

      if (media.type === "video") {
        containerParams.media_type = "VIDEO";
        containerParams.video_url = media.url!;
      } else {
        containerParams.image_url = media.url!;
      }

      const container = await graphApiRequest<InstagramMediaContainer>(
        `/${accountId}/media?${new URLSearchParams(containerParams)}`,
        credentials.accessToken,
        { method: "POST" },
      );

      // Step 2: Publish the media
      const publishParams = new URLSearchParams({
        access_token: credentials.accessToken,
        creation_id: container.id,
      });

      const post = await graphApiRequest<{ id: string }>(
        `/${accountId}/media_publish?${publishParams}`,
        credentials.accessToken,
        { method: "POST" },
      );

      return {
        platform: "instagram",
        success: true,
        postId: post.id,
        postUrl: `https://instagram.com/p/${post.id}`,
      };
    }

    // Carousel (multiple images)
    const containerIds: string[] = [];

    // Create container for each image
    for (const media of content.media.slice(0, 10)) {
      const containerParams = new URLSearchParams({
        access_token: credentials.accessToken,
        is_carousel_item: "true",
      });

      if (media.type === "video") {
        containerParams.set("media_type", "VIDEO");
        containerParams.set("video_url", media.url!);
      } else {
        containerParams.set("image_url", media.url!);
      }

      const container = await graphApiRequest<InstagramMediaContainer>(
        `/${accountId}/media?${containerParams}`,
        credentials.accessToken,
        { method: "POST" },
      );

      containerIds.push(container.id);
    }

    // Create carousel container
    const carouselParams = new URLSearchParams({
      access_token: credentials.accessToken,
      media_type: "CAROUSEL",
      caption: content.text,
      children: containerIds.join(","),
    });

    const carousel = await graphApiRequest<InstagramMediaContainer>(
      `/${accountId}/media?${carouselParams}`,
      credentials.accessToken,
      { method: "POST" },
    );

    // Publish the carousel
    const publishParams = new URLSearchParams({
      access_token: credentials.accessToken,
      creation_id: carousel.id,
    });

    const post = await graphApiRequest<{ id: string }>(
      `/${accountId}/media_publish?${publishParams}`,
      credentials.accessToken,
      { method: "POST" },
    );

    return {
      platform: "instagram",
      success: true,
      postId: post.id,
      postUrl: `https://instagram.com/p/${post.id}`,
    };
  } catch (error) {
    logger.error("[Instagram] Post failed", { error });
    return {
      platform: "instagram",
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

export const metaProvider: SocialMediaProvider = {
  platform: "facebook",

  async validateCredentials(credentials: SocialCredentials) {
    if (!credentials.accessToken) {
      return { valid: false, error: "Access token required" };
    }

    try {
      // Get user info
      const response = await graphApiRequest<{
        id: string;
        name: string;
        accounts?: { data: FacebookPage[] };
      }>("/me?fields=id,name,accounts{id,name}", credentials.accessToken);

      return {
        valid: true,
        accountId: response.id,
        displayName: response.name,
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
    // Determine which platform to post to based on options
    if (options?.instagram?.accountId || credentials.accountId) {
      return createInstagramPost(credentials, content, options);
    }

    return createFacebookPost(credentials, content, options);
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    try {
      await graphApiRequest(
        `/${postId}?access_token=${credentials.accessToken}`,
        credentials.accessToken,
        { method: "DELETE" },
      );

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
      // Try Facebook insights
      const response = await graphApiRequest<{
        id: string;
        shares?: { count: number };
        likes?: { summary: { total_count: number } };
        comments?: { summary: { total_count: number } };
      }>(
        `/${postId}?fields=id,shares,likes.summary(true),comments.summary(true)`,
        credentials.accessToken,
      );

      return {
        platform: "facebook",
        postId,
        metrics: {
          likes: response.likes?.summary?.total_count || 0,
          comments: response.comments?.summary?.total_count || 0,
          shares: response.shares?.count || 0,
        },
        fetchedAt: new Date(),
      };
    } catch {
      // Try Instagram insights
      try {
        const response = await graphApiRequest<{
          id: string;
          like_count?: number;
          comments_count?: number;
        }>(`/${postId}?fields=id,like_count,comments_count`, credentials.accessToken);

        return {
          platform: "instagram",
          postId,
          metrics: {
            likes: response.like_count || 0,
            comments: response.comments_count || 0,
          },
          fetchedAt: new Date(),
        };
      } catch {
        return null;
      }
    }
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (!credentials.accessToken) {
      return null;
    }

    // Try Instagram account
    if (credentials.accountId) {
      try {
        const response = await graphApiRequest<InstagramAccount>(
          `/${credentials.accountId}?fields=id,username,name,profile_picture_url,followers_count,follows_count,media_count`,
          credentials.accessToken,
        );

        return {
          platform: "instagram",
          accountId: response.id,
          metrics: {
            followers: response.followers_count,
            following: response.follows_count,
            totalPosts: response.media_count,
          },
          fetchedAt: new Date(),
        };
      } catch {
        // Fall through to Facebook
      }
    }

    // Try Facebook page
    if (credentials.pageId) {
      try {
        const response = await graphApiRequest<{
          id: string;
          name: string;
          fan_count?: number;
        }>(`/${credentials.pageId}?fields=id,name,fan_count`, credentials.accessToken);

        return {
          platform: "facebook",
          accountId: response.id,
          metrics: {
            followers: response.fan_count,
          },
          fetchedAt: new Date(),
        };
      } catch {
        return null;
      }
    }

    return null;
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    // Meta doesn't require pre-uploading for most cases
    // The URL can be used directly in posts
    if (media.url) {
      return { mediaId: media.url, url: media.url };
    }

    throw new Error("Only URL-based media is supported");
  },

  async replyToPost(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
  ): Promise<PostResult> {
    if (!credentials.accessToken) {
      return {
        platform: "facebook",
        success: false,
        error: "Access token required",
      };
    }

    try {
      const params = new URLSearchParams({
        access_token: credentials.accessToken,
        message: content.text,
      });

      const response = await graphApiRequest<{ id: string }>(
        `/${postId}/comments?${params}`,
        credentials.accessToken,
        { method: "POST" },
      );

      return {
        platform: "facebook",
        success: true,
        postId: response.id,
      };
    } catch (error) {
      return {
        platform: "facebook",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async likePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    try {
      await graphApiRequest(
        `/${postId}/likes?access_token=${credentials.accessToken}`,
        credentials.accessToken,
        { method: "POST" },
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
