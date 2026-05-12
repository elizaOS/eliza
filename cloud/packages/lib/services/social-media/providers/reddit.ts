/**
 * Reddit Provider - Reddit API with OAuth2
 */

import type {
  AccountAnalytics,
  PlatformPostOptions,
  PostAnalytics,
  PostContent,
  PostResult,
  SocialCredentials,
  SocialMediaProvider,
} from "@/lib/types/social-media";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { safeJsonParse } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import { withRetry } from "../rate-limit";

const REDDIT_API_BASE = "https://oauth.reddit.com";
const REDDIT_AUTH_BASE = "https://www.reddit.com/api/v1";

interface RedditToken {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface RedditUser {
  id: string;
  name: string;
  icon_img?: string;
  total_karma?: number;
  link_karma?: number;
  comment_karma?: number;
}

interface RedditSubmission {
  id: string;
  name: string;
  url: string;
  permalink: string;
  title: string;
  score: number;
  num_comments: number;
  upvote_ratio: number;
}

async function getAccessToken(
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
): Promise<string> {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const { data } = await withRetry<RedditToken>(
    () =>
      fetch(`${REDDIT_AUTH_BASE}/access_token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ElizaCloud/1.0 (social-media-automation)",
        },
        body: new URLSearchParams({
          grant_type: "password",
          username,
          password,
        }),
      }),
    async (response) => {
      const json = (await response.json()) as RedditToken & {
        error?: string;
        error_description?: string;
      };
      if (json.error) throw new Error(json.error_description || json.error);
      return json;
    },
    { platform: "reddit", maxRetries: 2 },
  );

  return data.access_token;
}

async function redditApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${REDDIT_API_BASE}${endpoint}`;

  const { data } = await withRetry<T>(
    () =>
      fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ElizaCloud/1.0 (social-media-automation)",
          ...options.headers,
        },
      }),
    async (response) => {
      const json = (await response.json()) as T & {
        error?: string;
        error_description?: string;
      };
      if (json.error) throw new Error(json.error_description || json.error);
      return json;
    },
    { platform: "reddit", maxRetries: 3 },
  );

  return data;
}

async function _redditApiRequestLegacy<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${REDDIT_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ElizaCloud/1.0 (social-media-automation)",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await safeJsonParse<{ message?: string }>(response);
    throw new Error(error.message || `Reddit API error: ${response.status}`);
  }

  return response.json();
}

export const redditProvider: SocialMediaProvider = {
  platform: "reddit",

  async validateCredentials(credentials: SocialCredentials) {
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return {
        valid: false,
        error: "Client ID, secret, username, and password required",
      };
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      const user = await redditApiRequest<{ data: RedditUser }>("/api/v1/me", accessToken, {
        headers: { "Content-Type": "application/json" },
      });

      return {
        valid: true,
        accountId: user.data.id,
        username: user.data.name,
        displayName: user.data.name,
        avatarUrl: user.data.icon_img?.split("?")[0],
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
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return {
        platform: "reddit",
        success: false,
        error: "Credentials required",
      };
    }

    const subreddit = options?.reddit?.subreddit;
    const title = options?.reddit?.title;

    if (!subreddit) {
      return {
        platform: "reddit",
        success: false,
        error: "Subreddit required",
      };
    }

    if (!title) {
      return { platform: "reddit", success: false, error: "Title required" };
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      logger.info("[Reddit] Creating post", {
        subreddit,
        hasMedia: !!content.media?.length,
        hasLink: !!content.link,
      });

      // Determine post type
      let kind: "self" | "link" | "image" = "self";
      let url: string | undefined;

      if (content.link) {
        kind = "link";
        url = content.link;
      } else if (content.media?.length && content.media[0].url) {
        kind = "image";
        url = content.media[0].url;
      }

      const params = new URLSearchParams({
        sr: subreddit,
        kind,
        title,
        api_type: "json",
      });

      if (kind === "self") {
        params.set("text", content.text);
      } else if (url) {
        params.set("url", url);
      }

      if (options?.reddit?.flair) {
        params.set("flair_text", options.reddit.flair);
      }

      if (options?.reddit?.nsfw) {
        params.set("nsfw", "true");
      }

      if (options?.reddit?.spoiler) {
        params.set("spoiler", "true");
      }

      if (options?.reddit?.sendReplies === false) {
        params.set("sendreplies", "false");
      }

      const response = await redditApiRequest<{
        json: {
          data?: { id: string; name: string; url: string };
          errors?: string[][];
        };
      }>("/api/submit", accessToken, {
        method: "POST",
        body: params,
      });

      if (response.json.errors?.length) {
        const errorMessage = response.json.errors.map((e) => e.join(": ")).join(", ");
        return {
          platform: "reddit",
          success: false,
          error: errorMessage,
        };
      }

      const postData = response.json.data;
      if (!postData) {
        return {
          platform: "reddit",
          success: false,
          error: "No post data returned",
        };
      }

      return {
        platform: "reddit",
        success: true,
        postId: postData.id,
        postUrl: `https://reddit.com${postData.url || `/r/${subreddit}/comments/${postData.id}`}`,
      };
    } catch (error) {
      logger.error("[Reddit] Post failed", { error });
      return {
        platform: "reddit",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return { success: false, error: "Credentials required" };
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      // Reddit uses fullname (t3_id) for submissions
      const fullname = postId.startsWith("t3_") ? postId : `t3_${postId}`;

      await redditApiRequest("/api/del", accessToken, {
        method: "POST",
        body: new URLSearchParams({ id: fullname }),
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
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return null;
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      const cleanId = postId.replace("t3_", "");

      const response = await redditApiRequest<
        Array<{ data: { children: Array<{ data: RedditSubmission }> } }>
      >(`/api/info?id=t3_${cleanId}`, accessToken, {
        headers: { "Content-Type": "application/json" },
      });

      const post = response[0]?.data?.children?.[0]?.data;
      if (!post) return null;

      return {
        platform: "reddit",
        postId,
        metrics: {
          likes: post.score,
          comments: post.num_comments,
          engagementRate: post.upvote_ratio * 100,
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return null;
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      const user = await redditApiRequest<{ data: RedditUser }>("/api/v1/me", accessToken, {
        headers: { "Content-Type": "application/json" },
      });

      return {
        platform: "reddit",
        accountId: user.data.id,
        metrics: {
          totalPosts: (user.data.link_karma || 0) + (user.data.comment_karma || 0),
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async replyToPost(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
  ): Promise<PostResult> {
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return {
        platform: "reddit",
        success: false,
        error: "Credentials required",
      };
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      const fullname = postId.startsWith("t3_") ? postId : `t3_${postId}`;

      const response = await redditApiRequest<{
        json: {
          data?: { things: Array<{ data: { id: string } }> };
          errors?: string[][];
        };
      }>("/api/comment", accessToken, {
        method: "POST",
        body: new URLSearchParams({
          thing_id: fullname,
          text: content.text,
          api_type: "json",
        }),
      });

      if (response.json.errors?.length) {
        return {
          platform: "reddit",
          success: false,
          error: response.json.errors.map((e) => e.join(": ")).join(", "),
        };
      }

      const commentId = response.json.data?.things?.[0]?.data?.id;

      return {
        platform: "reddit",
        success: true,
        postId: commentId || postId,
      };
    } catch (error) {
      return {
        platform: "reddit",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async likePost(credentials: SocialCredentials, postId: string) {
    if (
      !credentials.apiKey ||
      !credentials.apiSecret ||
      !credentials.username ||
      !credentials.password
    ) {
      return { success: false, error: "Credentials required" };
    }

    try {
      const accessToken = await getAccessToken(
        credentials.apiKey,
        credentials.apiSecret,
        credentials.username,
        credentials.password,
      );

      const fullname = postId.startsWith("t3_") ? postId : `t3_${postId}`;

      await redditApiRequest("/api/vote", accessToken, {
        method: "POST",
        body: new URLSearchParams({
          id: fullname,
          dir: "1", // 1 = upvote, 0 = unvote, -1 = downvote
        }),
      });

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
