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
} from "../../../types/social-media";
import { extractErrorMessage } from "../../../utils/error-handling";
import { logger } from "../../../utils/logger";
import {
  assertSocialMediaBytesWithinBudget,
  decodeSocialMediaBase64,
  downloadSocialMediaBytes,
} from "../media-download";
import {
  failedPostResult,
  type RetryOptions,
  SocialApiRejectionError,
  UnknownPostOutcomeError,
  withRetry,
} from "../rate-limit";

const BLUESKY_SERVICE = "https://bsky.social";

const BLUESKY_REQUEST_TIMEOUT_MS = 30_000;
const BLUESKY_MAX_IMAGES_PER_POST = 4;

/**
 * Bound every Bluesky / AT Protocol hop so a hung or rate-limited API cannot
 * pin the publishing worker indefinitely.
 * A caller-provided signal is composed with the deadline rather than
 * replacing it — a caller that cancels still aborts early, and a caller
 * whose signal never fires still cannot outlive the bound.
 */
export function blueskyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = BLUESKY_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

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
      blueskyFetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password: appPassword }),
      }),
    async (response) => {
      const json = (await response.json()) as BskySession & { error?: string; message?: string };
      if (json.error) throw new SocialApiRejectionError(json.message || json.error);
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
  retry: Pick<RetryOptions, "replayUnknownOutcome"> = {},
): Promise<T> {
  const { data } = await withRetry<T>(
    () =>
      blueskyFetch(`${BLUESKY_SERVICE}/xrpc/${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      }),
    async (response) => {
      const json = (await response.json()) as T & { error?: string; message?: string };
      if (json.error) throw new SocialApiRejectionError(json.message || json.error);
      return json;
    },
    { platform: "bluesky", maxRetries: 3, ...retry },
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
  const response = await blueskyFetch(`${BLUESKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
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

async function resolveHandle(handle: string, accessJwt: string): Promise<string | null> {
  const response = await blueskyFetch(
    `${BLUESKY_SERVICE}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    { headers: { Authorization: `Bearer ${accessJwt}` } },
  );
  // The PDS answers 400 for a handle that does not exist: that mention stays
  // plain text. Any other failure fails the post so it can be retried.
  if (response.status === 400) {
    await response.body?.cancel();
    logger.warn("[Bluesky] Mention handle does not resolve", { handle });
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Bluesky handle lookup failed: ${response.status}`);
  }
  const { did } = (await response.json()) as { did?: unknown };
  if (typeof did !== "string" || !did.startsWith("did:")) {
    throw new Error("Bluesky handle lookup returned an invalid DID");
  }
  return did;
}

// Mentions follow https://docs.bsky.app/docs/advanced-guides/post-richtext: they
// start at the beginning of the text, after whitespace or after "(", and a
// mention facet needs the DID the handle resolves to.
async function detectFacets(text: string, accessJwt: string): Promise<BskyFacet[]> {
  const facets: BskyFacet[] = [];
  const encoder = new TextEncoder();
  const byteOffset = (charIndex: number) => encoder.encode(text.slice(0, charIndex)).length;

  // Detect URLs
  const urlRegex = /https?:\/\/[^\s]+/g;
  const linkRanges: Array<{ byteStart: number; byteEnd: number }> = [];
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const byteStart = byteOffset(match.index);
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    linkRanges.push({ byteStart, byteEnd });
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }],
    });
  }

  // Detect mentions
  const mentionRegex = /(^|\s|\()(@)([a-zA-Z0-9.-]+)(\b)/g;
  const mentions: Array<{ handle: string; byteStart: number; byteEnd: number }> = [];
  while ((match = mentionRegex.exec(text)) !== null) {
    const handle = match[3];
    if (!handle.includes(".")) continue;
    const byteStart = byteOffset(match.index + match[1].length);
    const byteEnd = byteStart + encoder.encode(`@${handle}`).length;
    if (linkRanges.some((link) => byteStart < link.byteEnd && link.byteStart < byteEnd)) {
      continue;
    }
    mentions.push({ handle, byteStart, byteEnd });
  }
  const handles = [...new Set(mentions.map((m) => m.handle))];
  const dids = new Map(
    await Promise.all(
      handles.map(async (handle) => [handle, await resolveHandle(handle, accessJwt)] as const),
    ),
  );
  for (const { handle, byteStart, byteEnd } of mentions) {
    const did = dids.get(handle);
    if (!did) continue;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#mention", did }],
    });
  }

  // Detect hashtags; a "#fragment" inside a link is part of the link, not a tag.
  const hashtagRegex = /#([a-zA-Z0-9_]+)/g;
  while ((match = hashtagRegex.exec(text)) !== null) {
    const byteStart = byteOffset(match.index);
    const byteEnd = byteStart + encoder.encode(match[0]).length;
    if (linkRanges.some((link) => byteStart < link.byteEnd && link.byteStart < byteEnd)) {
      continue;
    }
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
      // error-policy:J1 boundary translation of the Bluesky auth call into the typed
      // invalid-credentials result the caller renders; a failure, not a fabricated success.
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

    if (content.media?.length) {
      if (content.media.length > BLUESKY_MAX_IMAGES_PER_POST) {
        return {
          platform: "bluesky",
          success: false,
          error: `Bluesky posts support at most ${BLUESKY_MAX_IMAGES_PER_POST} images; nothing was posted`,
        };
      }
      const invalidMedia = content.media.find(
        (media) => media.type !== "image" || (!media.data && !media.base64 && !media.url),
      );
      if (invalidMedia) {
        return {
          platform: "bluesky",
          success: false,
          error:
            "Bluesky posts currently support only images with data, base64, or a URL; nothing was posted",
        };
      }
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
      const facets = await detectFacets(content.text, session.accessJwt);
      if (facets.length > 0) {
        record.facets = facets;
      }

      // Handles supported media attachments, currently images
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

        for (const media of content.media) {
          let imageData: Buffer;
          if (media.data) {
            assertSocialMediaBytesWithinBudget(media.data.length, { platform: "bluesky" });
            imageData = media.data;
          } else if (media.base64) {
            imageData = decodeSocialMediaBase64(media.base64, { platform: "bluesky" });
          } else if (media.url) {
            imageData = await downloadSocialMediaBytes(media.url);
          } else {
            throw new Error("Validated Bluesky image is missing its payload");
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
        { replayUnknownOutcome: false },
      );

      // A 2xx body without the created record URI is not a publication
      // receipt: Bluesky may have published, so the outcome stays unknown
      // and the credit is held instead of refunded (the slack/telegram rule).
      const uri = response?.uri;
      if (typeof uri !== "string" || !uri.trim()) {
        throw new UnknownPostOutcomeError(
          "bluesky",
          new Error("Bluesky response lacks a publication receipt"),
        );
      }

      // Extract rkey from URI for URL
      const rkey = uri.split("/").pop();

      return {
        platform: "bluesky",
        success: true,
        postId: uri,
        postUrl: `https://bsky.app/profile/${session.handle}/post/${rkey}`,
        metadata: { cid: response.cid },
      };
    } catch (error) {
      // error-policy:J1 boundary translation of the Bluesky post call into the typed
      // PostResult failure the caller renders; a failure, not a fabricated success.
      logger.error("[Bluesky] Post failed", { error });
      return failedPostResult("bluesky", error);
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
      // error-policy:J1 boundary translation of the Bluesky delete call into the typed
      // failure result the caller renders; a failure, not a fabricated success.
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
    // `null` is the designed "analytics unavailable for an unconfigured account" signal;
    // a real session/fetch failure must propagate, not be masked as that empty state.
    if (!credentials.handle || !credentials.appPassword) {
      return null;
    }

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
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    // `null` is the designed "analytics unavailable for an unconfigured account" signal;
    // a real session/fetch failure must propagate, not be masked as that empty state.
    if (!credentials.handle || !credentials.appPassword) {
      return null;
    }

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
  },

  async uploadMedia(credentials: SocialCredentials, media: MediaAttachment) {
    if (!credentials.handle || !credentials.appPassword) {
      throw new Error("Handle and app password required");
    }

    const session = await createSession(credentials.handle, credentials.appPassword);

    let imageData: Buffer;
    if (media.data) {
      assertSocialMediaBytesWithinBudget(media.data.length, { platform: "bluesky" });
      imageData = media.data;
    } else if (media.base64) {
      imageData = decodeSocialMediaBase64(media.base64, { platform: "bluesky" });
    } else if (media.url) {
      imageData = await downloadSocialMediaBytes(media.url);
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

      await bskyApiRequest(
        "com.atproto.repo.createRecord",
        session.accessJwt,
        {
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
        },
        // A replay after a timeout writes a second like record under a
        // fresh key (the create and repost calls in this file pass the
        // same flag).
        { replayUnknownOutcome: false },
      );

      return { success: true };
    } catch (error) {
      // error-policy:J1 boundary translation of the Bluesky like call into the typed
      // failure result the caller renders; a failure, not a fabricated success.
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
        { replayUnknownOutcome: false },
      );

      // A 2xx body without the created record uri is not a publication
      // receipt: the repost may exist, so the outcome stays unknown
      // instead of reporting a success with no post id (the rule the
      // create path in this file follows).
      const repostUri = response?.uri;
      if (typeof repostUri !== "string" || !repostUri) {
        throw new UnknownPostOutcomeError(
          "bluesky",
          new Error("Bluesky response lacks a publication receipt"),
        );
      }

      return {
        platform: "bluesky",
        success: true,
        postId: repostUri,
      };
    } catch (error) {
      // error-policy:J1 boundary translation of the Bluesky repost call into the typed
      // PostResult failure the caller renders; a failure, not a fabricated success.
      return failedPostResult("bluesky", error);
    }
  },
};
