/**
 * Implements TikTok Content Posting API operations, including bounded inline
 * video transfer through the provider's sequential ranged-upload protocol.
 */

import { ElizaError } from "@elizaos/core";

import { safeFetch } from "../../../security/safe-fetch";
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
import {
  SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES,
  SOCIAL_MEDIA_VIDEO_MAX_BYTES,
} from "../../../types/social-media";
import { extractErrorMessage } from "../../../utils/error-handling";
import { logger } from "../../../utils/logger";
import { assertSocialMediaBytesWithinBudget, decodeSocialMediaBase64 } from "../media-download";
import { withRetry } from "../rate-limit";

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

const TIKTOK_REQUEST_TIMEOUT_MS = 30_000;
const TIKTOK_UPLOAD_CHUNK_BYTES = 10_000_000;
const TIKTOK_UPLOAD_MAX_RETRIES = 2;
const TIKTOK_UPLOAD_RETRY_BASE_DELAY_MS = 100;
const TIKTOK_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);

export interface TikTokUploadChunk {
  firstByte: number;
  lastByte: number;
  byteLength: number;
}

export interface TikTokUploadPlan {
  chunkSize: number;
  totalChunkCount: number;
  chunks: TikTokUploadChunk[];
}

function tiktokUploadError(
  message: string,
  code: string,
  context: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    context,
    severity: "ephemeral",
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Normalizes the three video containers accepted by TikTok's upload API. */
export function validateTikTokVideoMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!TIKTOK_VIDEO_MIME_TYPES.has(normalized)) {
    throw tiktokUploadError(
      "TikTok file uploads require MP4, QuickTime, or WebM video",
      "TIKTOK_VIDEO_MIME_INVALID",
      {
        mimeType,
      },
    );
  }
  return normalized;
}

/**
 * Restricts provider-returned upload capabilities to TikTok's documented
 * HTTPS host family before the shared DNS/SSRF guard opens a connection.
 */
export function validateTikTokUploadUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw tiktokUploadError(
      "TikTok returned an invalid upload URL",
      "TIKTOK_UPLOAD_URL_INVALID",
      {},
      cause,
    );
  }

  const hostname = url.hostname.toLowerCase();
  const allowedHost =
    hostname === "open-upload.tiktokapis.com" ||
    /^upload\.[a-z0-9-]+\.tiktokapis\.com$/.test(hostname);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !allowedHost
  ) {
    throw tiktokUploadError(
      "TikTok returned an upload URL outside the allowed HTTPS host family",
      "TIKTOK_UPLOAD_URL_INVALID",
      { protocol: url.protocol, hostname, port: url.port || "443" },
    );
  }

  return url.toString();
}

/**
 * Plans the sequential ranges required by TikTok's decimal-MB upload
 * protocol. The final range absorbs the remainder so it cannot become an
 * undersized trailing chunk.
 */
export function createTikTokUploadPlan(videoSize: number): TikTokUploadPlan {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) {
    throw new ElizaError("TikTok video data must contain a positive whole number of bytes", {
      code: "TIKTOK_INVALID_VIDEO_SIZE",
      context: { videoSize },
      severity: "ephemeral",
    });
  }

  const chunkSize = Math.min(videoSize, TIKTOK_UPLOAD_CHUNK_BYTES);
  const totalChunkCount = Math.floor(videoSize / chunkSize);
  const chunks = Array.from({ length: totalChunkCount }, (_, index) => {
    const firstByte = index * chunkSize;
    const lastByte = index === totalChunkCount - 1 ? videoSize - 1 : firstByte + chunkSize - 1;
    return {
      firstByte,
      lastByte,
      byteLength: lastByte - firstByte + 1,
    };
  });

  return { chunkSize, totalChunkCount, chunks };
}

function uploadBodyView(videoData: Buffer, chunk: TikTokUploadChunk): Uint8Array<ArrayBuffer> {
  const chunkView = videoData.subarray(chunk.firstByte, chunk.lastByte + 1);
  if (videoData.buffer instanceof ArrayBuffer) {
    return new Uint8Array(videoData.buffer, chunkView.byteOffset, chunkView.byteLength);
  }

  // Fetch BodyInit requires ArrayBuffer-backed views in the Worker types. A
  // SharedArrayBuffer input was accepted before ranged uploads, so retain that
  // compatibility with one bounded copy per outgoing chunk, never a second
  // full-video allocation.
  return Uint8Array.from(chunkView);
}

async function cancelTikTokUploadResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // error-policy:J6 Upload response teardown is best-effort after its status
    // has already supplied the authoritative transport result.
  }
}

function waitBeforeTikTokUploadRetry(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, TIKTOK_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
  );
}

async function uploadTikTokVideo(
  uploadUrl: string,
  videoData: Buffer,
  plan: TikTokUploadPlan,
  mimeType: string,
  startChunkIndex = 0,
): Promise<void> {
  for (let index = startChunkIndex; index < plan.chunks.length; index += 1) {
    const chunk = plan.chunks[index];
    if (!chunk) {
      throw tiktokUploadError(
        "TikTok upload plan is missing a requested chunk",
        "TIKTOK_UPLOAD_PLAN_INVALID",
        {
          chunkIndex: index,
          totalChunkCount: plan.totalChunkCount,
        },
      );
    }
    const finalChunk = index === plan.chunks.length - 1;
    const expectedStatus = finalChunk ? 201 : 206;
    for (let attempt = 0; attempt <= TIKTOK_UPLOAD_MAX_RETRIES; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await safeFetch(uploadUrl, {
          method: "PUT",
          redirect: "manual",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(chunk.byteLength),
            "Content-Range": `bytes ${chunk.firstByte}-${chunk.lastByte}/${videoData.length}`,
          },
          body: uploadBodyView(videoData, chunk),
          signal: AbortSignal.timeout(TIKTOK_REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        // error-policy:J2 Preserve the ambiguous transport failure: the remote
        // side may have committed the range even though its response was lost.
        // A final-chunk response loss is reconciled before any replay because
        // it may be a lost 201. Intermediate ranges use bounded exact replay.
        if (!finalChunk && attempt < TIKTOK_UPLOAD_MAX_RETRIES) {
          await waitBeforeTikTokUploadRetry(attempt);
          continue;
        }
        throw tiktokUploadError(
          `TikTok upload chunk ${index + 1}/${plan.totalChunkCount} has an unknown remote outcome`,
          "TIKTOK_UPLOAD_OUTCOME_UNKNOWN",
          {
            chunkIndex: index,
            totalChunkCount: plan.totalChunkCount,
            firstByte: chunk.firstByte,
            lastByte: chunk.lastByte,
            finalChunk,
          },
          cause,
        );
      }

      try {
        if (response.status === expectedStatus) break;

        if (
          response.status >= 500 &&
          response.status <= 599 &&
          attempt < TIKTOK_UPLOAD_MAX_RETRIES
        ) {
          await waitBeforeTikTokUploadRetry(attempt);
          continue;
        }

        throw tiktokUploadError(
          `TikTok upload chunk ${index + 1}/${plan.totalChunkCount} returned ${response.status}; expected ${expectedStatus}`,
          "TIKTOK_UPLOAD_CHUNK_STATUS_INVALID",
          {
            chunkIndex: index,
            totalChunkCount: plan.totalChunkCount,
            firstByte: chunk.firstByte,
            lastByte: chunk.lastByte,
            actualStatus: response.status,
            expectedStatus,
          },
        );
      } finally {
        await cancelTikTokUploadResponse(response);
      }
    }
  }
}

/**
 * Bound every TikTok REST hop so a hung or rate-limited API cannot pin the
 * publishing worker indefinitely. A caller-provided abort signal wins.
 */
export function tiktokFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = TIKTOK_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

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
      tiktokFetch(url, {
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
    const status = await fetchPublishStatus(accessToken, publishId);

    if (status.status === "PUBLISH_COMPLETE") {
      return status;
    }

    if (status.status === "FAILED") {
      throw tiktokUploadError(
        status.fail_reason || "TikTok publish failed",
        "TIKTOK_PUBLISH_FAILED",
        {
          publishId,
        },
      );
    }

    // Wait before checking again
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw tiktokUploadError(
    "TikTok publish status is still unresolved",
    "TIKTOK_PUBLISH_STATUS_UNKNOWN",
    {
      publishId,
      maxWait,
    },
  );
}

function fetchPublishStatus(accessToken: string, publishId: string): Promise<TikTokPublishStatus> {
  return tiktokApiRequest<TikTokPublishStatus>(`/post/publish/status/fetch/`, accessToken, {
    method: "POST",
    body: JSON.stringify({ publish_id: publishId }),
  });
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
      // error-policy:J1 boundary translation — upstream auth-check failure becomes the
      // structured {valid:false,error} result the credential-connect flow renders.
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
        const videoMimeType = validateTikTokVideoMimeType(video.mimeType);
        // Bounded against the video ceiling rather than the image budget: the
        // decode is a single allocation inside the Worker isolate, so it needs
        // a bound even though 10 MiB would reject ordinary video posts.
        const videoData = video.data
          ? (assertSocialMediaBytesWithinBudget(
              video.data.byteLength,
              { platform: "tiktok" },
              SOCIAL_MEDIA_VIDEO_MAX_BYTES,
            ),
            video.data)
          : decodeSocialMediaBase64(
              video.base64!,
              { platform: "tiktok" },
              SOCIAL_MEDIA_VIDEO_MAX_BASE64_BYTES,
            );
        const uploadPlan = createTikTokUploadPlan(videoData.length);

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
                chunk_size: uploadPlan.chunkSize,
                total_chunk_count: uploadPlan.totalChunkCount,
              },
            }),
          },
        );

        if (!initResponse.upload_url) {
          throw tiktokUploadError(
            "TikTok did not provide an upload URL",
            "TIKTOK_UPLOAD_URL_MISSING",
            { publishId: initResponse.publish_id },
          );
        }

        const uploadUrl = validateTikTokUploadUrl(initResponse.upload_url);
        try {
          await uploadTikTokVideo(uploadUrl, videoData, uploadPlan, videoMimeType);
        } catch (error) {
          if (!(error instanceof ElizaError) || error.code !== "TIKTOK_UPLOAD_OUTCOME_UNKNOWN") {
            throw error;
          }

          // error-policy:J4 A lost upload response is neither success nor a
          // refund-safe failure. Query TikTok once: terminal state is
          // authoritative; unresolved state is visibly returned with a credit
          // hold so no duplicate post/refund is fabricated.
          let reconciliation: TikTokPublishStatus | undefined;
          try {
            reconciliation = await fetchPublishStatus(
              credentials.accessToken,
              initResponse.publish_id,
            );
          } catch (reconciliationError) {
            logger.warn("[TikTok] Upload outcome reconciliation request failed", {
              publishId: initResponse.publish_id,
              error: extractErrorMessage(reconciliationError),
            });
          }

          if (reconciliation?.status === "PROCESSING_UPLOAD") {
            const chunkIndex = error.context?.chunkIndex;
            if (typeof chunkIndex === "number") {
              try {
                await uploadTikTokVideo(
                  uploadUrl,
                  videoData,
                  uploadPlan,
                  videoMimeType,
                  chunkIndex,
                );
                reconciliation = await waitForPublish(
                  credentials.accessToken,
                  initResponse.publish_id,
                );
              } catch (replayError) {
                if (
                  !(replayError instanceof ElizaError) ||
                  !["TIKTOK_UPLOAD_OUTCOME_UNKNOWN", "TIKTOK_PUBLISH_STATUS_UNKNOWN"].includes(
                    replayError.code,
                  )
                ) {
                  throw replayError;
                }
                logger.warn("[TikTok] Upload replay remains unresolved", {
                  publishId: initResponse.publish_id,
                  chunkIndex,
                  error: extractErrorMessage(replayError),
                });
              }
            }
          } else if (
            reconciliation?.status === "PROCESSING_DOWNLOAD" ||
            reconciliation?.status === "SEND_TO_USER_INBOX"
          ) {
            try {
              reconciliation = await waitForPublish(
                credentials.accessToken,
                initResponse.publish_id,
              );
            } catch (statusError) {
              if (
                !(statusError instanceof ElizaError) ||
                statusError.code !== "TIKTOK_PUBLISH_STATUS_UNKNOWN"
              ) {
                throw statusError;
              }
              logger.warn("[TikTok] Advanced publish status remains unresolved", {
                publishId: initResponse.publish_id,
                error: extractErrorMessage(statusError),
              });
            }
          }

          if (reconciliation?.status === "PUBLISH_COMPLETE") {
            const postId = reconciliation.publicaly_available_post_id?.[0];
            return {
              platform: "tiktok",
              success: true,
              postId: postId || initResponse.publish_id,
              postUrl: postId ? `https://www.tiktok.com/@me/video/${postId}` : undefined,
              metadata: { publishId: initResponse.publish_id, reconciled: true },
            };
          }

          if (reconciliation?.status === "FAILED") {
            throw tiktokUploadError(
              reconciliation.fail_reason || "TikTok upload failed after an ambiguous response",
              "TIKTOK_UPLOAD_FAILED_AFTER_RECONCILIATION",
              { publishId: initResponse.publish_id },
              error,
            );
          }

          return {
            platform: "tiktok",
            success: false,
            error: "TikTok upload outcome is still being reconciled",
            errorCode: "TIKTOK_UPLOAD_OUTCOME_UNKNOWN",
            creditDisposition: "hold",
            metadata: {
              publishId: initResponse.publish_id,
              providerStatus: reconciliation?.status ?? "UNKNOWN",
            },
          };
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
      // error-policy:J1 boundary translation — a failed post becomes the {success:false}
      // PostResult the caller inspects; socialMediaService relies on this (not a throw) to
      // drive the per-platform credit refund (#11680).
      logger.error("[TikTok] Post failed", { error });
      return {
        platform: "tiktok",
        success: false,
        error: extractErrorMessage(error),
        errorCode: error instanceof ElizaError ? error.code : undefined,
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

    // `null` is the designed-empty result — upstream returned zero matching videos.
    // An internal failure (transport/5xx/rate-limit) throws out of tiktokApiRequest and
    // must stay distinguishable from this, so it is deliberately NOT caught here.
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
  },

  async getAccountAnalytics(credentials: SocialCredentials): Promise<AccountAnalytics | null> {
    if (!credentials.accessToken) {
      return null;
    }

    // No catch: an upstream failure throws out of tiktokApiRequest and propagates so the
    // caller sees a broken pipeline, never a fabricated null "no data" result. The only
    // `null` this method returns is the designed no-credentials guard above.
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
