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
import { logger } from "@/lib/utils/logger";
import { withRetry } from "../rate-limit";

interface MastodonStatus {
  id: string;
  uri: string;
  url: string;
  created_at: string;
  content: string;
  visibility: string;
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  media_attachments: Array<{
    id: string;
    type: string;
    url: string;
    preview_url: string;
  }>;
  account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  };
}

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
}

interface MastodonMedia {
  id: string;
  type: string;
  url: string;
  preview_url: string;
}

function getInstanceUrl(credentials: SocialCredentials): string {
  const url = credentials.instanceUrl ?? credentials.webhookUrl ?? "https://mastodon.social";
  return url.replace(/\/$/, "");
}

async function mastodonApiRequest<T>(
  instanceUrl: string,
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const { data } = await withRetry<T>(
    () =>
      fetch(`${instanceUrl}/api/v1${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }),
    async (response) => {
      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Mastodon API error: ${response.status} - ${error}`);
      }
      return response.json();
    },
    { platform: "mastodon", maxRetries: 3 },
  );

  return data;
}

async function uploadMedia(
  instanceUrl: string,
  accessToken: string,
  media: MediaAttachment,
): Promise<MastodonMedia> {
  let fileData: Buffer;

  if (media.data) {
    fileData = media.data;
  } else if (media.base64) {
    fileData = Buffer.from(media.base64, "base64");
  } else if (media.url) {
    const response = await fetch(media.url);
    fileData = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("No media data provided");
  }

  const fileBytes = Uint8Array.from(fileData);
  const formData = new FormData();
  formData.append("file", new Blob([fileBytes], { type: media.mimeType }), "upload");
  if (media.altText) {
    formData.append("description", media.altText);
  }

  const response = await fetch(`${instanceUrl}/api/v2/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Media upload failed: ${response.status} - ${error}`);
  }

  return response.json();
}

export const mastodonProvider: SocialMediaProvider = {
  platform: "mastodon",

  async validateCredentials(credentials: SocialCredentials) {
    if (!credentials.accessToken) {
      return { valid: false, error: "Access token required" };
    }

    const instanceUrl = getInstanceUrl(credentials);

    const account = await mastodonApiRequest<MastodonAccount>(
      instanceUrl,
      "/accounts/verify_credentials",
      credentials.accessToken,
    );

    return {
      valid: true,
      accountId: account.id,
      username: account.username,
      displayName: account.display_name,
      avatarUrl: account.avatar,
    };
  },

  async createPost(
    credentials: SocialCredentials,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    if (!credentials.accessToken) {
      return {
        platform: "mastodon",
        success: false,
        error: "Access token required",
      };
    }

    const instanceUrl = getInstanceUrl(credentials);
    const mastodonOptions = options?.mastodon;

    logger.info("[Mastodon] Creating post", {
      hasMedia: !!content.media?.length,
    });

    const mediaIds: string[] = [];
    if (content.media?.length) {
      for (const media of content.media) {
        const uploaded = await uploadMedia(instanceUrl, credentials.accessToken, media);
        mediaIds.push(uploaded.id);
      }
    }

    const payload: Record<string, unknown> = {
      status: content.text,
      visibility: mastodonOptions?.visibility ?? "public",
    };

    if (mediaIds.length > 0) payload.media_ids = mediaIds;
    if (content.replyToId) payload.in_reply_to_id = content.replyToId;
    if (mastodonOptions?.sensitive) payload.sensitive = true;
    if (mastodonOptions?.spoilerText) payload.spoiler_text = mastodonOptions.spoilerText;
    if (mastodonOptions?.language) payload.language = mastodonOptions.language;
    if (mastodonOptions?.pollOptions?.length) {
      payload.poll = {
        options: mastodonOptions.pollOptions,
        expires_in: mastodonOptions.pollExpiresIn ?? 86400,
      };
    }

    const status = await mastodonApiRequest<MastodonStatus>(
      instanceUrl,
      "/statuses",
      credentials.accessToken,
      { method: "POST", body: JSON.stringify(payload) },
    );

    return {
      platform: "mastodon",
      success: true,
      postId: status.id,
      postUrl: status.url,
      metadata: { visibility: status.visibility },
    };
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    const instanceUrl = getInstanceUrl(credentials);

    await mastodonApiRequest(instanceUrl, `/statuses/${postId}`, credentials.accessToken, {
      method: "DELETE",
    });

    return { success: true };
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
    if (!credentials.accessToken) {
      return { success: false, error: "Access token required" };
    }

    const instanceUrl = getInstanceUrl(credentials);

    await mastodonApiRequest(
      instanceUrl,
      `/statuses/${postId}/favourite`,
      credentials.accessToken,
      { method: "POST" },
    );

    return { success: true };
  },

  async repost(credentials: SocialCredentials, postId: string): Promise<PostResult> {
    if (!credentials.accessToken) {
      return {
        platform: "mastodon",
        success: false,
        error: "Access token required",
      };
    }

    const instanceUrl = getInstanceUrl(credentials);

    const status = await mastodonApiRequest<MastodonStatus>(
      instanceUrl,
      `/statuses/${postId}/reblog`,
      credentials.accessToken,
      { method: "POST" },
    );

    return {
      platform: "mastodon",
      success: true,
      postId: status.id,
      postUrl: status.url,
    };
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    if (!credentials.accessToken) {
      throw new Error("Access token required");
    }

    const instanceUrl = getInstanceUrl(credentials);
    const uploaded = await uploadMedia(instanceUrl, credentials.accessToken, media);

    return {
      mediaId: uploaded.id,
      url: uploaded.url,
    };
  },

  async getPostAnalytics(
    credentials: SocialCredentials,
    postId: string,
  ): Promise<PostAnalytics | null> {
    if (!credentials.accessToken) return null;

    const instanceUrl = getInstanceUrl(credentials);

    const status = await mastodonApiRequest<MastodonStatus>(
      instanceUrl,
      `/statuses/${postId}`,
      credentials.accessToken,
    );

    return {
      platform: "mastodon",
      postId: status.id,
      metrics: {
        likes: status.favourites_count,
        reposts: status.reblogs_count,
        comments: status.replies_count,
      },
      fetchedAt: new Date(),
    };
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (!credentials.accessToken) return null;

    const instanceUrl = getInstanceUrl(credentials);

    const account = await mastodonApiRequest<MastodonAccount>(
      instanceUrl,
      "/accounts/verify_credentials",
      credentials.accessToken,
    );

    return {
      platform: "mastodon",
      accountId: account.id,
      metrics: {
        followers: account.followers_count,
        following: account.following_count,
        totalPosts: account.statuses_count,
      },
      fetchedAt: new Date(),
    };
  },
};
