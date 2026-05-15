import type { UserV2 } from "twitter-api-v2";
import type { RequestApiResult } from "./api-types";
import type { TwitterAuth } from "./auth";

/**
 * A parsed profile object.
 */
/**
 * Interface representing a user profile.
 * @typedef {Object} Profile
 * @property {string} [avatar] - The URL to the user's avatar.
 * @property {string} [banner] - The URL to the user's banner image.
 * @property {string} [biography] - The user's biography.
 * @property {string} [birthday] - The user's birthday.
 * @property {number} [followersCount] - The number of followers the user has.
 * @property {number} [followingCount] - The number of users the user is following.
 * @property {number} [friendsCount] - The number of friends the user has.
 * @property {number} [mediaCount] - The number of media items the user has posted.
 * @property {number} [statusesCount] - The number of statuses the user has posted.
 * @property {boolean} [isPrivate] - Indicates if the user's profile is private.
 * @property {boolean} [isVerified] - Indicates if the user account is verified.
 * @property {boolean} [isBlueVerified] - Indicates if the user account has blue verification badge.
 * @property {Date} [joined] - The date the user joined the platform.
 * @property {number} [likesCount] - The number of likes the user has received.
 * @property {number} [listedCount] - The number of times the user has been listed.
 * @property {string} location - The user's location.
 * @property {string} [name] - The user's name.
 * @property {string[]} [pinnedTweetIds] - The IDs of the user's pinned tweets.
 * @property {number} [tweetsCount] - The number of tweets the user has posted.
 * @property {string} [url] - The user's website URL.
 * @property {string} [userId] - The unique user ID.
 * @property {string} [username] - The user's username.
 * @property {string} [website] - The user's website.
 * @property {boolean} [canDm] - Indicates if the user can receive direct messages.
 */
export interface Profile {
  avatar?: string;
  banner?: string;
  biography?: string;
  birthday?: string;
  followersCount?: number;
  followingCount?: number;
  friendsCount?: number;
  mediaCount?: number;
  statusesCount?: number;
  isPrivate?: boolean;
  isVerified?: boolean;
  isBlueVerified?: boolean;
  joined?: Date;
  likesCount?: number;
  listedCount?: number;
  location: string;
  name?: string;
  pinnedTweetIds?: string[];
  tweetsCount?: number;
  url?: string;
  userId?: string;
  username?: string;
  website?: string;
  canDm?: boolean;
}

function getAvatarOriginalSizeUrl(avatarUrl: string | undefined) {
  return avatarUrl ? avatarUrl.replace("_normal", "") : undefined;
}

/**
 * Convert Twitter API v2 user data to Profile format
 */
function parseV2Profile(user: UserV2): Profile {
  const profile: Profile = {
    avatar: getAvatarOriginalSizeUrl(user.profile_image_url),
    biography: user.description,
    followersCount: user.public_metrics?.followers_count,
    followingCount: user.public_metrics?.following_count,
    friendsCount: user.public_metrics?.following_count,
    tweetsCount: user.public_metrics?.tweet_count,
    isPrivate: user.protected ?? false,
    isVerified: user.verified ?? false,
    likesCount: user.public_metrics?.like_count,
    listedCount: user.public_metrics?.listed_count,
    location: user.location || "",
    name: user.name,
    pinnedTweetIds: user.pinned_tweet_id ? [user.pinned_tweet_id] : [],
    url: `https://twitter.com/${user.username}`,
    userId: user.id,
    username: user.username,
    isBlueVerified: user.verified_type === "blue",
  };

  if (user.created_at) {
    profile.joined = new Date(user.created_at);
  }

  const urlEntry = user.entities?.url?.urls?.[0];
  if (urlEntry?.expanded_url) {
    profile.website = urlEntry.expanded_url;
  }

  return profile;
}

export async function getProfile(
  username: string,
  auth: TwitterAuth,
): Promise<RequestApiResult<Profile>> {
  if (!auth) {
    return {
      success: false,
      err: new Error("Not authenticated"),
    };
  }

  try {
    const client = await auth.getV2Client();
    const user = await client.v2.userByUsername(username, {
      "user.fields": [
        "id",
        "name",
        "username",
        "created_at",
        "description",
        "entities",
        "location",
        "pinned_tweet_id",
        "profile_image_url",
        "protected",
        "public_metrics",
        "url",
        "verified",
        "verified_type",
      ],
    });

    if (!user.data) {
      return {
        success: false,
        err: new Error(`User ${username} not found`),
      };
    }

    return {
      success: true,
      value: parseV2Profile(user.data),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      err: new Error(message || "Failed to fetch profile"),
    };
  }
}

const idCache = new Map<string, string>();

export async function getScreenNameByUserId(
  userId: string,
  auth: TwitterAuth,
): Promise<RequestApiResult<string>> {
  if (!auth) {
    return {
      success: false,
      err: new Error("Not authenticated"),
    };
  }

  try {
    const client = await auth.getV2Client();
    const user = await client.v2.user(userId, {
      "user.fields": ["username"],
    });

    if (!user.data?.username) {
      return {
        success: false,
        err: new Error(`User with ID ${userId} not found`),
      };
    }

    return {
      success: true,
      value: user.data.username,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      err: new Error(message || "Failed to fetch user"),
    };
  }
}

export async function getEntityIdByScreenName(
  screenName: string,
  auth: TwitterAuth,
): Promise<RequestApiResult<string>> {
  const cached = idCache.get(screenName);
  if (cached != null) {
    return { success: true, value: cached };
  }

  const profileRes = await getProfile(screenName, auth);
  if (!profileRes.success) {
    return profileRes;
  }

  const profile = profileRes.value;
  if (profile.userId != null) {
    idCache.set(screenName, profile.userId);

    return {
      success: true,
      value: profile.userId,
    };
  }

  return {
    success: false,
    err: new Error("User ID is undefined."),
  };
}
