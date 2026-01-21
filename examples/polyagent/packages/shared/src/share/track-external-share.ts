/**
 * External Share Tracking
 *
 * @description Client-side utility for tracking external shares (Twitter, Farcaster, etc.)
 * and awarding points to users. Makes API calls to record share actions.
 */

import { logger } from "../utils/logger";

export type SharePlatform =
  | "twitter"
  | "farcaster"
  | "link"
  | "native"
  | "download"
  | "other";

export type ShareContentType =
  | "post"
  | "profile"
  | "market"
  | "referral"
  | "leaderboard";

export interface TrackExternalShareOptions {
  platform: SharePlatform;
  contentType: ShareContentType;
  contentId?: string;
  url: string;
  userId?: string | null;
}

export interface TrackExternalShareResult {
  shareActionId: string | null;
  pointsAwarded: number;
  alreadyAwarded: boolean;
}

const DEFAULT_RESULT: TrackExternalShareResult = {
  shareActionId: null,
  pointsAwarded: 0,
  alreadyAwarded: false,
};

/**
 * Track an external share and award points if applicable
 *
 * @description Makes an API call to record a share action and award points.
 * Returns information about points awarded and whether the share was already tracked.
 *
 * @param {TrackExternalShareOptions} options - Share tracking options
 * @returns {Promise<TrackExternalShareResult>} Result with points awarded info
 *
 * @example
 * ```typescript
 * const result = await trackExternalShare({
 *   platform: 'twitter',
 *   contentType: 'post',
 *   contentId: '123',
 *   url: 'https://polyagent.market/post/123',
 *   userId: 'user-123'
 * });
 * ```
 */
export async function trackExternalShare(
  options: TrackExternalShareOptions,
): Promise<TrackExternalShareResult> {
  const { platform, contentType, contentId, url, userId } = options;

  if (!userId) {
    logger.warn(
      "Unable to track external share without authenticated user",
      { platform, contentType },
      "trackExternalShare",
    );
    return DEFAULT_RESULT;
  }

  const token =
    typeof window !== "undefined"
      ? ((window as { __privyAccessToken?: string }).__privyAccessToken ?? null)
      : null;
  if (!token) {
    logger.warn(
      "No access token available when attempting to track external share",
      { platform },
      "trackExternalShare",
    );
    return DEFAULT_RESULT;
  }

  const response = await fetch(
    `/api/users/${encodeURIComponent(userId)}/share`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform,
        contentType,
        contentId,
        url,
      }),
    },
  );

  if (!response.ok) {
    const errorPayload = (await response.json()) as {
      error?: string;
    };
    logger.warn(
      "Failed to track external share",
      { platform, status: response.status, error: errorPayload?.error },
      "trackExternalShare",
    );
    return DEFAULT_RESULT;
  }

  const data = (await response.json()) as {
    points?: { awarded?: number; alreadyAwarded?: boolean };
    shareAction?: { id?: string };
  };
  const pointsAwarded = Number(data?.points?.awarded ?? 0);
  const alreadyAwarded = Boolean(data?.points?.alreadyAwarded);
  const shareActionId = data?.shareAction?.id ?? null;

  if (pointsAwarded > 0) {
    logger.info(
      `Awarded ${pointsAwarded} points for ${platform} share`,
      { platform, pointsAwarded },
      "trackExternalShare",
    );
  }

  return {
    shareActionId,
    pointsAwarded,
    alreadyAwarded,
  };
}
