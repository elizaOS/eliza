/** Implements X publishing, media upload, and analytics for cloud social-media callers. */
import { ElizaError } from "@elizaos/core";
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
import { TWITTER_API_BASE, TWITTER_UPLOAD_BASE } from "../../../utils/twitter-api";
import {
  assertSocialMediaBytesWithinBudget,
  decodeSocialMediaBase64,
  downloadSocialMediaBytes,
} from "../media-download";
import { withRetry } from "../rate-limit";

const TWITTER_REQUEST_TIMEOUT_MS = 30_000;
const TWITTER_RETRY_SEQUENCE_TIMEOUT_MS = 60_000;
const TWITTER_UPLOAD_SEQUENCE_TIMEOUT_MS = 120_000;
const MAX_TWITTER_POST_MEDIA = 4;
const TWITTER_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_TWITTER_RETRY_ATTEMPT_BUDGET_MS = 1_000;
const MIN_TWITTER_PROCESSING_POLL_MS = 250;

async function bufferTwitterResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > TWITTER_RESPONSE_MAX_BYTES) {
      const error = new ElizaError("X/Twitter response exceeds the byte limit", {
        code: "TWITTER_RESPONSE_TOO_LARGE",
        context: { declaredBytes, maxBytes: TWITTER_RESPONSE_MAX_BYTES },
      });
      if (response.body) {
        try {
          await response.body.cancel(error);
        } catch (cause) {
          // error-policy:J6 The response already failed closed; cancellation only releases the
          // unread transport body.
          logger.debug("[Twitter] Failed to cancel declared-oversize response body", { cause });
        }
      }
      throw error;
    }
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const cancelBody = (): void => {
    reader.cancel(signal.reason).catch((cause: unknown) => {
      // error-policy:J6 The hop already failed; cancellation only releases its response stream.
      logger.debug("[Twitter] Failed to cancel aborted response body", { cause });
    });
  };
  signal.addEventListener("abort", cancelBody, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      receivedBytes += next.value.byteLength;
      if (receivedBytes > TWITTER_RESPONSE_MAX_BYTES) {
        const error = new ElizaError("X/Twitter response exceeds the byte limit", {
          code: "TWITTER_RESPONSE_TOO_LARGE",
          context: { receivedBytes, maxBytes: TWITTER_RESPONSE_MAX_BYTES },
        });
        try {
          await reader.cancel(error);
        } catch (cause) {
          // error-policy:J6 The bounded read already failed; cancellation only releases the stream.
          logger.debug("[Twitter] Failed to cancel oversized response body", { cause });
        }
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelBody);
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body.buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Bound every X/Twitter REST hop so a hung or rate-limited API cannot pin the
 * publishing worker indefinitely. Caller cancellation and the deadline are
 * composed so neither can disable the other.
 */
export async function twitterFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = TWITTER_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new ElizaError("X/Twitter timeout must be a positive timer-safe integer", {
      code: "INVALID_TWITTER_TIMEOUT",
      context: { timeoutMs },
    });
  }

  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onCallerAbort = (): void =>
    abort(
      init?.signal?.reason ?? new DOMException("The X/Twitter request was aborted.", "AbortError"),
    );
  init?.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (init?.signal?.aborted) onCallerAbort();
  const timeoutId = setTimeout(
    () => abort(new DOMException("X/Twitter API request timed out", "TimeoutError")),
    timeoutMs,
  );
  try {
    if (controller.signal.aborted) return await abortPromise;
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      abortPromise,
    ]);
    return await Promise.race([bufferTwitterResponse(response, controller.signal), abortPromise]);
  } finally {
    clearTimeout(timeoutId);
    init?.signal?.removeEventListener("abort", onCallerAbort);
  }
}

// Wrapped with retry logic for social media provider
async function twitterApiRequest<T>(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${TWITTER_API_BASE}${endpoint}`;
  const deadline = new AbortController();
  const deadlineAt = Date.now() + TWITTER_RETRY_SEQUENCE_TIMEOUT_MS;
  const timeoutId = setTimeout(() => {
    deadline.abort(new DOMException("X/Twitter retry sequence timed out", "TimeoutError"));
  }, TWITTER_RETRY_SEQUENCE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  try {
    const { data } = await withRetry<T>(
      () => {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= MIN_TWITTER_RETRY_ATTEMPT_BUDGET_MS) {
          throw new DOMException("X/Twitter retry sequence timed out", "TimeoutError");
        }
        return twitterFetch(
          url,
          {
            ...options,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              ...options.headers,
            },
            signal,
          },
          Math.min(TWITTER_REQUEST_TIMEOUT_MS, remainingMs),
        );
      },
      async (response) => response.json(),
      {
        platform: "twitter",
        maxRetries: 3,
        signal,
        deadlineAt,
        minimumAttemptBudgetMs: MIN_TWITTER_RETRY_ATTEMPT_BUDGET_MS,
      },
    );
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function uploadMedia(accessToken: string, media: MediaAttachment): Promise<string> {
  const deadline = new AbortController();
  const timeoutId = setTimeout(() => {
    deadline.abort(new DOMException("X/Twitter media upload timed out", "TimeoutError"));
  }, TWITTER_UPLOAD_SEQUENCE_TIMEOUT_MS);
  try {
    let mediaData: Buffer;
    if (media.data) {
      assertSocialMediaBytesWithinBudget(media.data.length, { platform: "twitter" });
      mediaData = media.data;
    } else if (media.base64) {
      mediaData = decodeSocialMediaBase64(media.base64, { platform: "twitter" });
    } else if (media.url) {
      mediaData = await downloadSocialMediaBytes(media.url, { signal: deadline.signal });
    } else {
      throw new Error("No media data provided");
    }

    const mediaType = media.type === "video" ? "tweet_video" : "tweet_image";

    if (media.type === "image" && mediaData.length < 5 * 1024 * 1024) {
      const formData = new URLSearchParams();
      formData.append("media_data", mediaData.toString("base64"));
      formData.append("media_category", mediaType);

      const response = await twitterFetch(`${TWITTER_UPLOAD_BASE}/media/upload.json`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData,
        signal: deadline.signal,
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

    const initResponse = await twitterFetch(
      `${TWITTER_UPLOAD_BASE}/media/upload.json?${initParams}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: deadline.signal,
      },
    );

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

      const appendResponse = await twitterFetch(
        `${TWITTER_UPLOAD_BASE}/media/upload.json?${appendParams}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: formData,
          signal: deadline.signal,
        },
      );

      if (!appendResponse.ok) {
        throw new Error(`Media upload APPEND failed at segment ${segmentIndex}`);
      }
      segmentIndex++;
    }

    const finalizeParams = new URLSearchParams({
      command: "FINALIZE",
      media_id: mediaId,
    });

    const finalizeResponse = await twitterFetch(
      `${TWITTER_UPLOAD_BASE}/media/upload.json?${finalizeParams}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: deadline.signal,
      },
    );

    if (!finalizeResponse.ok) {
      throw new Error("Media upload FINALIZE failed");
    }

    const finalizeData = (await finalizeResponse.json()) as { processing_info?: unknown };

    if (finalizeData.processing_info !== undefined) {
      if (
        typeof finalizeData.processing_info !== "object" ||
        finalizeData.processing_info === null ||
        Array.isArray(finalizeData.processing_info)
      ) {
        throw new Error("Media upload FINALIZE returned malformed processing_info");
      }
      await waitForProcessing(accessToken, mediaId, 60_000, deadline.signal);
    }

    return mediaId;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function waitForProcessing(
  accessToken: string,
  mediaId: string,
  maxWait = 60000,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(maxWait) || maxWait <= 0 || maxWait > MAX_TIMER_DELAY_MS) {
    throw new ElizaError("X/Twitter media processing timeout must be timer-safe", {
      code: "INVALID_TWITTER_PROCESSING_TIMEOUT",
      context: { maxWait },
    });
  }
  const processingDeadline = new AbortController();
  const timeoutId = setTimeout(() => {
    processingDeadline.abort(
      new DOMException("X/Twitter media processing timed out", "TimeoutError"),
    );
  }, maxWait);
  const processingSignal = signal
    ? AbortSignal.any([signal, processingDeadline.signal])
    : processingDeadline.signal;
  const deadlineAt = Date.now() + maxWait;

  try {
    while (true) {
      processingSignal.throwIfAborted();
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      const statusParams = new URLSearchParams({
        command: "STATUS",
        media_id: mediaId,
      });

      const response = await twitterFetch(
        `${TWITTER_UPLOAD_BASE}/media/upload.json?${statusParams}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: processingSignal,
        },
        Math.min(TWITTER_REQUEST_TIMEOUT_MS, remainingMs),
      );

      if (!response.ok) {
        throw new Error(`Media processing STATUS failed: ${response.status}`);
      }

      const data = (await response.json()) as { processing_info?: unknown };

      if (data.processing_info === undefined) {
        return; // Processing complete
      }
      if (
        typeof data.processing_info !== "object" ||
        data.processing_info === null ||
        Array.isArray(data.processing_info)
      ) {
        throw new Error("Media processing returned malformed processing_info");
      }
      const processingInfo = data.processing_info as {
        state?: unknown;
        check_after_secs?: unknown;
        error?: { message?: string };
      };
      if (processingInfo.state === "succeeded") return;
      if (processingInfo.state === "failed") {
        throw new Error(
          `Media processing failed: ${processingInfo.error?.message || "Unknown error"}`,
        );
      }
      if (processingInfo.state !== "pending" && processingInfo.state !== "in_progress") {
        throw new Error("Media processing returned an invalid state");
      }

      const rawWaitSeconds = processingInfo.check_after_secs ?? 5;
      if (
        typeof rawWaitSeconds !== "number" ||
        !Number.isFinite(rawWaitSeconds) ||
        rawWaitSeconds < 0
      ) {
        throw new Error("Media processing returned an invalid check_after_secs");
      }
      const remainingAfterReadMs = deadlineAt - Date.now();
      if (remainingAfterReadMs <= 0) break;
      const requestedWaitMs = Math.min(Math.ceil(rawWaitSeconds * 1000), MAX_TIMER_DELAY_MS);
      const waitTime = Math.min(
        Math.max(requestedWaitMs, MIN_TWITTER_PROCESSING_POLL_MS),
        remainingAfterReadMs,
      );
      await new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
          if (timeout !== undefined) clearTimeout(timeout);
          reject(processingSignal.reason);
        };
        if (processingSignal.aborted) {
          onAbort();
          return;
        }
        timeout = setTimeout(() => {
          processingSignal.removeEventListener("abort", onAbort);
          resolve();
        }, waitTime);
        processingSignal.addEventListener("abort", onAbort, { once: true });
      });
    }
  } finally {
    clearTimeout(timeoutId);
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
      // error-policy:J1 boundary translation — an outbound Twitter auth-check failure becomes
      // the typed {valid:false} the connect flow depends on, not a fabricated valid credential.
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
        if (content.media.length > MAX_TWITTER_POST_MEDIA) {
          throw new Error(`X/Twitter posts support at most ${MAX_TWITTER_POST_MEDIA} media items`);
        }
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
      // error-policy:J1 boundary translation — a failed Twitter post becomes the {success:false}
      // PostResult the credit-refund flow depends on, never a fabricated success.
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
      // error-policy:J1 boundary translation — a failed Twitter delete becomes a typed
      // {success:false} result the caller inspects, not a swallowed error.
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
    // `null` is reserved for the designed no-credentials guard. An internal upstream
    // failure throws out of twitterApiRequest and propagates so a broken pipeline never
    // reads as a fabricated "no analytics" result — it must stay distinguishable from the
    // provider-not-configured `null` the service layer treats as empty.
    if (!credentials.accessToken) {
      return null;
    }

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
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    // See getPostAnalytics: `null` is only the no-credentials guard; upstream failures throw.
    if (!credentials.accessToken) {
      return null;
    }

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
      // error-policy:J1 boundary translation — a failed Twitter like becomes a typed
      // {success:false} result the caller inspects, not a swallowed error.
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
      // error-policy:J1 boundary translation — a failed Twitter repost becomes the {success:false}
      // PostResult the caller inspects, never a fabricated success.
      return {
        platform: "twitter",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
