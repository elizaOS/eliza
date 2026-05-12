/**
 * Bluesky Provider - AT Protocol
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

const BLUESKY_SERVICE = "https://bsky.social";

interface BskySession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

interface BskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}

interface BskyFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; uri?: string; tag?: string; did?: string }>;
}

async function createSession(handle: string, appPassword: string): Promise<BskySession> {
  const { data } = await withRetry<BskySession>(
    () =>
      fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password: appPassword }),
      }),
    async (response) => {
      const json = (await response.json()) as BskySession & { error?: string; message?: string };
      if (json.error) throw new Error(json.message || json.error);
      return json;
    },
    { platform: "bluesky", maxRetries: 2 },
  );
  return data;
}

async function bskyApiRequest<T>(
  endpoint: string,
  accessJwt: string,
  options: RequestInit = {},
): Promise<T> {
  const { data } = await withRetry<T>(
    () =>
      fetch(`${BLUESKY_SERVICE}/xrpc/${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }),
    async (response) => {
      const json = (await response.json()) as T & { error?: string; message?: string };
      if (json.error) throw new Error(json.message || json.error);
      return json;
    },
    { platform: "bluesky", maxRetries: 3 },
  );
  return data;
}

async function uploadBlob(
  accessJwt: string,
  data: Buffer,
  mimeType: string,
): Promise<{
  blob: {
    $type: string;
    ref: { $link: string };
    mimeType: string;
    size: number;
  };
}> {
  const response = await fetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessJwt}`,
      "Content-Type": mimeType,
    },
    body: new Uint8Array(data),
  });

  if (!response.ok) {
    throw new Error(`Blob upload failed: ${response.status}`);
  }

  return response.json();
}

function detectFacets(text: string): BskyFacet[] {
  const facets: BskyFacet[] = [];
  const encoder = new TextEncoder();
  const _textBytes = encoder.encode(text);

  // Detect URLs
  const urlRegex = /https?:\/\/[^\s]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }],
    });
  }

  // Detect mentions
  const mentionRegex = /@([a-zA-Z0-9._-]+)/g;
  while ((match = mentionRegex.exec(text)) !== null) {
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#mention", did: match[1] }],
    });
  }

  // Detect hashtags
  const hashtagRegex = /#([a-zA-Z0-9_]+)/g;
  while ((match = hashtagRegex.exec(text)) !== null) {
    const byteStart = encoder.encode(text.slice(0, match.index)).length;
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[1] }],
    });
  }

  return facets;
}

export const blueskyProvider: SocialMediaProvider = {
  platform: "bluesky",

  async validateCredentials(credentials: SocialCredentials) {
    if (!credentials.handle || !credentials.appPassword) {
      return { valid: false, error: "Handle and app password required" };
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      // Get profile
      const profile = await bskyApiRequest<{ data: BskyProfile }>(
        `app.bsky.actor.getProfile?actor=${session.did}`,
        session.accessJwt,
      );

      return {
        valid: true,
        accountId: session.did,
        username: session.handle,
        displayName: profile.data?.displayName,
        avatarUrl: profile.data?.avatar,
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
    if (!credentials.handle || !credentials.appPassword) {
      return {
        platform: "bluesky",
        success: false,
        error: "Handle and app password required",
      };
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      // Build post record
      const record: Record<string, unknown> = {
        $type: "app.bsky.feed.post",
        text: content.text,
        createdAt: new Date().toISOString(),
      };

      // Add facets (links, mentions, hashtags)
      const facets = detectFacets(content.text);
      if (facets.length > 0) {
        record.facets = facets;
      }

      // Handle media attachments (images only for now)
      if (content.media?.length) {
        const images: Array<{
          alt: string;
          image: {
            $type: string;
            ref: { $link: string };
            mimeType: string;
            size: number;
          };
        }> = [];

        for (const media of content.media.slice(0, 4)) {
          if (media.type !== "image") continue;

          let imageData: Buffer;
          if (media.data) {
            imageData = media.data;
          } else if (media.base64) {
            imageData = Buffer.from(media.base64, "base64");
          } else if (media.url) {
            const response = await fetch(media.url);
            imageData = Buffer.from(await response.arrayBuffer());
          } else {
            continue;
          }

          const blobResponse = await uploadBlob(session.accessJwt, imageData, media.mimeType);

          images.push({
            alt: media.altText || "",
            image: blobResponse.blob,
          });
        }

        if (images.length > 0) {
          record.embed = {
            $type: "app.bsky.embed.images",
            images,
          };
        }
      }

      // Handle reply
      if (content.replyToId) {
        // Parse AT URI to get root and parent
        record.reply = {
          root: { uri: content.replyToId, cid: "" }, // CID needs to be fetched
          parent: { uri: content.replyToId, cid: "" },
        };
      }

      // Handle languages
      if (options?.bluesky?.languages?.length) {
        record.langs = options.bluesky.languages;
      }

      logger.info("[Bluesky] Creating post", {
        hasMedia: !!content.media?.length,
      });

      const response = await bskyApiRequest<{ uri: string; cid: string }>(
        "com.atproto.repo.createRecord",
        session.accessJwt,
        {
          method: "POST",
          body: JSON.stringify({
            repo: session.did,
            collection: "app.bsky.feed.post",
            record,
          }),
        },
      );

      // Extract rkey from URI for URL
      const rkey = response.uri.split("/").pop();

      return {
        platform: "bluesky",
        success: true,
        postId: response.uri,
        postUrl: `https://bsky.app/profile/${session.handle}/post/${rkey}`,
        metadata: { cid: response.cid },
      };
    } catch (error) {
      logger.error("[Bluesky] Post failed", { error });
      return {
        platform: "bluesky",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.handle || !credentials.appPassword) {
      return { success: false, error: "Handle and app password required" };
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      // Extract rkey from URI
      const rkey = postId.split("/").pop();

      await bskyApiRequest("com.atproto.repo.deleteRecord", session.accessJwt, {
        method: "POST",
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.post",
          rkey,
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

  async getPostAnalytics(
    credentials: SocialCredentials,
    postId: string,
  ): Promise<PostAnalytics | null> {
    if (!credentials.handle || !credentials.appPassword) {
      return null;
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      const response = await bskyApiRequest<{
        post: {
          likeCount: number;
          repostCount: number;
          replyCount: number;
        };
      }>(`app.bsky.feed.getPostThread?uri=${encodeURIComponent(postId)}`, session.accessJwt);

      return {
        platform: "bluesky",
        postId,
        metrics: {
          likes: response.post.likeCount,
          reposts: response.post.repostCount,
          comments: response.post.replyCount,
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (!credentials.handle || !credentials.appPassword) {
      return null;
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      const response = await bskyApiRequest<BskyProfile>(
        `app.bsky.actor.getProfile?actor=${session.did}`,
        session.accessJwt,
      );

      return {
        platform: "bluesky",
        accountId: response.did,
        metrics: {
          followers: response.followersCount,
          following: response.followsCount,
          totalPosts: response.postsCount,
        },
        fetchedAt: new Date(),
      };
    } catch {
      return null;
    }
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    if (!credentials.handle || !credentials.appPassword) {
      throw new Error("Handle and app password required");
    }

    const session = await createSession(credentials.handle, credentials.appPassword);

    let imageData: Buffer;
    if (media.data) {
      imageData = media.data;
    } else if (media.base64) {
      imageData = Buffer.from(media.base64, "base64");
    } else if (media.url) {
      const response = await fetch(media.url);
      imageData = Buffer.from(await response.arrayBuffer());
    } else {
      throw new Error("No media data provided");
    }

    const blobResponse = await uploadBlob(session.accessJwt, imageData, media.mimeType);

    return {
      mediaId: blobResponse.blob.ref.$link,
    };
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
    if (!credentials.handle || !credentials.appPassword) {
      return { success: false, error: "Handle and app password required" };
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      // Get the post to get its CID
      const postResponse = await bskyApiRequest<{
        thread: { post: { cid: string } };
      }>(
        `app.bsky.feed.getPostThread?uri=${encodeURIComponent(postId)}&depth=0`,
        session.accessJwt,
      );

      await bskyApiRequest("com.atproto.repo.createRecord", session.accessJwt, {
        method: "POST",
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.like",
          record: {
            $type: "app.bsky.feed.like",
            subject: { uri: postId, cid: postResponse.thread.post.cid },
            createdAt: new Date().toISOString(),
          },
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

  async repost(credentials: SocialCredentials, postId: string): Promise<PostResult> {
    if (!credentials.handle || !credentials.appPassword) {
      return {
        platform: "bluesky",
        success: false,
        error: "Handle and app password required",
      };
    }

    try {
      const session = await createSession(credentials.handle, credentials.appPassword);

      // Get the post to get its CID
      const postResponse = await bskyApiRequest<{
        thread: { post: { cid: string } };
      }>(
        `app.bsky.feed.getPostThread?uri=${encodeURIComponent(postId)}&depth=0`,
        session.accessJwt,
      );

      const response = await bskyApiRequest<{ uri: string; cid: string }>(
        "com.atproto.repo.createRecord",
        session.accessJwt,
        {
          method: "POST",
          body: JSON.stringify({
            repo: session.did,
            collection: "app.bsky.feed.repost",
            record: {
              $type: "app.bsky.feed.repost",
              subject: { uri: postId, cid: postResponse.thread.post.cid },
              createdAt: new Date().toISOString(),
            },
          }),
        },
      );

      return {
        platform: "bluesky",
        success: true,
        postId: response.uri,
      };
    } catch (error) {
      return {
        platform: "bluesky",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
