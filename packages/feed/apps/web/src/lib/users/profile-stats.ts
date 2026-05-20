import { cachedDb } from "@feed/api";
import { logger } from "@feed/shared";

export type ProfileStats = {
  positions: number;
  comments: number;
  reactions: number;
  followers: number;
  following: number;
  posts: number;
};

const EMPTY_PROFILE_STATS: ProfileStats = {
  positions: 0,
  comments: 0,
  reactions: 0,
  followers: 0,
  following: 0,
  posts: 0,
};

export async function getOptionalProfileStats(
  userId: string,
  context: string,
): Promise<ProfileStats> {
  try {
    const stats = await cachedDb.getUserProfileStats(userId);
    if (!stats) {
      logger.warn(
        "Profile stats unavailable; returning zero fallback",
        { userId },
        context,
      );
      return EMPTY_PROFILE_STATS;
    }

    return stats;
  } catch (error) {
    logger.error(
      "Failed to fetch profile stats; returning zero fallback",
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      context,
    );
    return EMPTY_PROFILE_STATS;
  }
}
