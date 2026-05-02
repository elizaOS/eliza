import type { RequestApiResult } from "./api-types";
import type { XAuth } from "./auth";
import type { XApiErrorRaw } from "./errors";

/**
 * Interface representing a raw user object from the X API.
 * @typedef {Object} XUserRaw
 * @property {string} [created_at] - The date the user was created.
 * @property {string} [description] - The user's description.
 * @property {Object} [entities] - Additional entities associated with the user.
 * @property {Object} [url] - The URL associated with the user.
 * @property {Object[]} [urls] - Array of URLs associated with the user.
 * @property {string} [expanded_url] - The expanded URL.
 * @property {number} [favourites_count] - The number of favorited items.
 * @property {number} [followers_count] - The number of followers.
 * @property {number} [friends_count] - The number of friends.
 * @property {number} [media_count] - The number of media items.
 * @property {number} [statuses_count] - The number of statuses.
 * @property {string} [id_str] - The user ID as a string.
 * @property {number} [listed_count] - The number of lists the user is listed in.
 * @property {string} [name] - The user's name.
 * @property {string} location - The user's location.
 * @property {boolean} [geo_enabled] - Indicates if geo locations are enabled.
 * @property {string[]} [pinned_tweet_ids_str] - Array of pinned post IDs as strings.
 * @property {string} [profile_background_color] - The background color of the user's profile.
 * @property {string} [profile_banner_url] - The URL of the user's profile banner.
 * @property {string} [profile_image_url_https] - The URL of the user's profile image (HTTPS).
 * @property {boolean} [protected] - Indicates if the user's account is protected.
 * @property {string} [screen_name] - The user's screen name.
 * @property {boolean} [verified] - Indicates if the user is verified.
 * @property {boolean} [has_custom_timelines] - Indicates if the user has custom timelines.
 * @property {boolean} [has_extended_profile] - Indicates if the user has an extended profile.
 * @property {string} [url] - The user's URL.
 * @property {boolean} [can_dm] - Indicates if direct messages are enabled for the user.
 */
export interface XUserRaw {
  created_at?: string;
  description?: string;
  entities?: {
    url?: {
      urls?: {
        expanded_url?: string;
      }[];
    };
  };
  favourites_count?: number;
  followers_count?: number;
  friends_count?: number;
  media_count?: number;
  statuses_count?: number;
  id_str?: string;
  listed_count?: number;
  name?: string;
  location: string;
  geo_enabled?: boolean;
  pinned_tweet_ids_str?: string[];
  profile_background_color?: string;
  profile_banner_url?: string;
  profile_image_url_https?: string;
  protected?: boolean;
  screen_name?: string;
  verified?: boolean;
  has_custom_timelines?: boolean;
  has_extended_profile?: boolean;
  url?: string;
  can_dm?: boolean;
}

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
 * @property {string[]} [pinnedPostIds] - The IDs of the user's pinned posts.
 * @property {number} [postsCount] - The number of posts the user has posted.
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
  pinnedPostIds?: string[];
  postsCount?: number;
  url?: string;
  userId?: string;
  username?: string;
  website?: string;
  canDm?: boolean;
}

export interface UserRaw {
  data: {
    user: {
      result: {
        rest_id?: string;
        is_blue_verified?: boolean;
        legacy: XUserRaw;
      };
    };
  };
  errors?: XApiErrorRaw[];
}

function getAvatarOriginalSizeUrl(avatarUrl: string | undefined) {
  return avatarUrl ? avatarUrl.replace("_normal", "") : undefined;
}

export function parseProfile(user: XUserRaw, isBlueVerified?: boolean): Profile {
  const profile: Profile = {
    avatar: getAvatarOriginalSizeUrl(user.profile_image_url_https),
    banner: user.profile_banner_url,
    biography: user.description,
    followersCount: user.followers_count,
    followingCount: user.friends_count,
    friendsCount: user.friends_count,
    mediaCount: user.media_count,
    isPrivate: user.protected ?? false,
    isVerified: user.verified,
    likesCount: user.favourites_count,
    listedCount: user.listed_count,
    location: user.location,
    name: user.name,
    pinnedPostIds: user.pinned_tweet_ids_str,
    postsCount: user.statuses_count,
    url: `https://x.com/${user.screen_name}`,
    userId: user.id_str,
    username: user.screen_name,
    isBlueVerified: isBlueVerified ?? false,
    canDm: user.can_dm,
  };

  if (user.created_at != null) {
    profile.joined = new Date(Date.parse(user.created_at));
  }

  const urls = user.entities?.url?.urls;
  if (urls?.length != null && urls?.length > 0) {
    profile.website = urls[0].expanded_url;
  }

  return profile;
}

import type { UserV2 } from "twitter-api-v2";

/**
 * Convert X API v2 user data to Profile format
 */
function parseV2Profile(user: UserV2): Profile {
  const profile: Profile = {
    avatar: getAvatarOriginalSizeUrl(user.profile_image_url),
    biography: user.description,
    followersCount: user.public_metrics?.followers_count,
    followingCount: user.public_metrics?.following_count,
    friendsCount: user.public_metrics?.following_count,
    postsCount: user.public_metrics?.tweet_count,
    isPrivate: user.protected ?? false,
    isVerified: user.verified ?? false,
    likesCount: user.public_metrics?.like_count,
    listedCount: user.public_metrics?.listed_count,
    location: user.location || "",
    name: user.name,
    pinnedPostIds: user.pinned_tweet_id ? [user.pinned_tweet_id] : [],
    url: `https://x.com/${user.username}`,
    userId: user.id,
    username: user.username,
    isBlueVerified: user.verified_type === "blue",
  };

  if (user.created_at) {
    profile.joined = new Date(user.created_at);
  }

  if (user.entities?.url?.urls && user.entities.url.urls.length > 0) {
    profile.website = user.entities.url.urls[0]?.expanded_url;
  }

  return profile;
}

export async function getProfile(
  username: string,
  auth: XAuth
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
    return {
      success: false,
      err: new Error(error instanceof Error ? error.message : "Failed to fetch profile"),
    };
  }
}

const idCache = new Map<string, string>();

export async function getScreenNameByUserId(
  userId: string,
  auth: XAuth
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

    if (!user.data || !user.data.username) {
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
    return {
      success: false,
      err: new Error(error instanceof Error ? error.message : "Failed to fetch user"),
    };
  }
}

export async function getEntityIdByScreenName(
  screenName: string,
  auth: XAuth
): Promise<RequestApiResult<string>> {
  const cached = idCache.get(screenName);
  if (cached != null) {
    return { success: true, value: cached };
  }

  const profileRes = await getProfile(screenName, auth);
  if (!profileRes.success) {
    return { success: false, err: profileRes.err };
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
