import type { XAuth } from "./auth";
import type { Profile } from "./profile";
import type { QueryProfilesResponse } from "./types";

/** X API v2 user data shape */
interface XV2User {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  description?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    like_count?: number;
    listed_count?: number;
  };
  protected?: boolean;
  verified?: boolean;
  verified_type?: string;
  location?: string;
  pinned_tweet_id?: string;
  created_at?: string;
  entities?: {
    url?: {
      urls?: Array<{ expanded_url?: string }>;
    };
  };
}

/**
 * Convert X API v2 user data to Profile format
 */
function parseV2UserToProfile(user: XV2User): Profile {
  return {
    avatar: user.profile_image_url?.replace("_normal", ""),
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
    joined: user.created_at ? new Date(user.created_at) : undefined,
    website: user.entities?.url?.urls?.[0]?.expanded_url,
  };
}

/**
 * Function to get the following profiles of a user.
 * @param {string} userId - The ID of the user to get the following profiles for.
 * @param {number} maxProfiles - The maximum number of profiles to retrieve.
 * @param {XAuth} auth - The X authentication credentials.
 * @returns {AsyncGenerator<Profile, void>} An async generator that yields Profile objects.
 */
export async function* getFollowing(
  userId: string,
  maxProfiles: number,
  auth: XAuth
): AsyncGenerator<Profile, void> {
  if (!auth) {
    throw new Error("Not authenticated");
  }

  const client = await auth.getV2Client();
  let count = 0;
  let paginationToken: string | undefined;

  try {
    while (count < maxProfiles) {
      const response = await client.v2.following(userId, {
        max_results: Math.min(maxProfiles - count, 100),
        pagination_token: paginationToken,
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

      if (!response.data || response.data.length === 0) {
        break;
      }

      for (const user of response.data) {
        if (count >= maxProfiles) break;
        yield parseV2UserToProfile(user);
        count++;
      }

      paginationToken = response.meta?.next_token;
      if (!paginationToken) break;
    }
  } catch (error) {
    console.error("Error fetching following:", error);
    throw error;
  }
}

/**
 * Get followers for a specific user.
 * @param {string} userId - The user ID for which to retrieve followers.
 * @param {number} maxProfiles - The maximum number of profiles to retrieve.
 * @param {XAuth} auth - The authentication credentials for the X API.
 * @returns {AsyncGenerator<Profile, void>} - An async generator that yields Profile objects representing followers.
 */
export async function* getFollowers(
  userId: string,
  maxProfiles: number,
  auth: XAuth
): AsyncGenerator<Profile, void> {
  if (!auth) {
    throw new Error("Not authenticated");
  }

  const client = await auth.getV2Client();
  let count = 0;
  let paginationToken: string | undefined;

  try {
    while (count < maxProfiles) {
      const response = await client.v2.followers(userId, {
        max_results: Math.min(maxProfiles - count, 100),
        pagination_token: paginationToken,
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

      if (!response.data || response.data.length === 0) {
        break;
      }

      for (const user of response.data) {
        if (count >= maxProfiles) break;
        yield parseV2UserToProfile(user);
        count++;
      }

      paginationToken = response.meta?.next_token;
      if (!paginationToken) break;
    }
  } catch (error) {
    console.error("Error fetching followers:", error);
    throw error;
  }
}

/**
 * Fetches the profiles that a user is following.
 * @param {string} userId - The ID of the user whose following profiles are to be fetched.
 * @param {number} maxProfiles - The maximum number of profiles to fetch.
 * @param {XAuth} auth - The X authentication details.
 * @param {string} [cursor] - Optional cursor for pagination.
 * @returns {Promise<QueryProfilesResponse>} A Promise that resolves with the response containing profiles the user is following.
 */
export async function fetchProfileFollowing(
  userId: string,
  maxProfiles: number,
  auth: XAuth,
  cursor?: string
): Promise<QueryProfilesResponse> {
  if (!auth) {
    throw new Error("Not authenticated");
  }

  const client = await auth.getV2Client();

  try {
    const response = await client.v2.following(userId, {
      max_results: Math.min(maxProfiles, 100),
      pagination_token: cursor,
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

    const profiles = response.data?.map(parseV2UserToProfile) || [];

    return {
      profiles,
      next: response.meta?.next_token,
    };
  } catch (error) {
    console.error("Error fetching following profiles:", error);
    throw error;
  }
}

/**
 * Fetches the profile followers for a given user ID.
 *
 * @param {string} userId - The user ID for which to fetch profile followers.
 * @param {number} maxProfiles - The maximum number of profiles to fetch.
 * @param {XAuth} auth - The X authentication credentials.
 * @param {string} [cursor] - Optional cursor for paginating results.
 * @returns {Promise<QueryProfilesResponse>} A promise that resolves with the parsed profile followers timeline.
 */
export async function fetchProfileFollowers(
  userId: string,
  maxProfiles: number,
  auth: XAuth,
  cursor?: string
): Promise<QueryProfilesResponse> {
  if (!auth) {
    throw new Error("Not authenticated");
  }

  const client = await auth.getV2Client();

  try {
    const response = await client.v2.followers(userId, {
      max_results: Math.min(maxProfiles, 100),
      pagination_token: cursor,
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

    const profiles = response.data?.map(parseV2UserToProfile) || [];

    return {
      profiles,
      next: response.meta?.next_token,
    };
  } catch (error) {
    console.error("Error fetching follower profiles:", error);
    throw error;
  }
}

/**
 * Follow a user using X API v2
 *
 * @param {string} username - The username to follow
 * @param {XAuth} auth - The authentication credentials
 * @returns {Promise<Response>} Response from the API
 */
export async function followUser(username: string, auth: XAuth): Promise<Response> {
  if (!auth) {
    throw new Error("Not authenticated");
  }

  const client = await auth.getV2Client();

  try {
    // First get the user ID from username
    const userResponse = await client.v2.userByUsername(username);
    if (!userResponse.data) {
      throw new Error(`User ${username} not found`);
    }

    // Get the authenticated user's ID
    const meResponse = await client.v2.me();
    if (!meResponse.data) {
      throw new Error("Failed to get authenticated user");
    }

    // Follow the user
    const result = await client.v2.follow(meResponse.data.id, userResponse.data.id);

    // Return a Response-like object for compatibility
    return new Response(JSON.stringify(result), {
      status: result.data?.following ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error following user:", error);
    throw error;
  }
}
