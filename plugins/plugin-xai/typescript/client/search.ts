import type { XAuth } from "./auth";
import type { Post } from "./posts";
import type { Profile } from "./profile";

/**
 * The categories that can be used in X searches.
 */
/**
 * Enum representing different search modes.
 * @enum {number}
 */

export enum SearchMode {
  Top = 0,
  Latest = 1,
  Photos = 2,
  Videos = 3,
  Users = 4,
}

/**
 * Search for posts using X API v2
 *
 * @param query Search query
 * @param maxPosts Maximum number of posts to return
 * @param searchMode Search mode (not all modes are supported in v2)
 * @param auth Authentication
 * @returns Async generator of posts
 */
export async function* searchPosts(
  query: string,
  maxPosts: number,
  searchMode: SearchMode,
  auth: XAuth
): AsyncGenerator<Post, void> {
  const client = await auth.getV2Client();

  // Build query based on search mode
  let finalQuery = query;
  switch (searchMode) {
    case SearchMode.Photos:
      finalQuery = `${query} has:media has:images`;
      break;
    case SearchMode.Videos:
      finalQuery = `${query} has:media has:videos`;
      break;
  }

  try {
    const searchIterator = await client.v2.search(finalQuery, {
      max_results: Math.min(maxPosts, 100),
      "tweet.fields": [
        "id",
        "text",
        "created_at",
        "author_id",
        "referenced_tweets",
        "entities",
        "public_metrics",
        "attachments",
      ],
      "user.fields": ["id", "name", "username", "profile_image_url"],
      "media.fields": ["url", "preview_image_url", "type"],
      expansions: ["author_id", "attachments.media_keys", "referenced_tweets.id"],
    });

    let count = 0;
    for await (const post of searchIterator) {
      if (count >= maxPosts) break;

      // Convert to Post format
      const convertedPost: Post = {
        id: post.id,
        text: post.text || "",
        timestamp: post.created_at ? new Date(post.created_at).getTime() : Date.now(),
        timeParsed: post.created_at ? new Date(post.created_at) : new Date(),
        userId: post.author_id || "",
        name: searchIterator.includes?.users?.find((u) => u.id === post.author_id)?.name || "",
        username:
          searchIterator.includes?.users?.find((u) => u.id === post.author_id)?.username || "",
        conversationId: post.id,
        hashtags: post.entities?.hashtags?.map((h) => h.tag) || [],
        mentions:
          post.entities?.mentions?.map((m) => ({
            id: m.id || "",
            username: m.username || "",
            name: "",
          })) || [],
        photos: [],
        thread: [],
        urls: post.entities?.urls?.map((u) => u.expanded_url || u.url) || [],
        videos: [],
        isRepost: post.referenced_tweets?.some((rt) => rt.type === "retweeted") || false,
        isReply: post.referenced_tweets?.some((rt) => rt.type === "replied_to") || false,
        isQuoted: post.referenced_tweets?.some((rt) => rt.type === "quoted") || false,
        isPin: false,
        sensitiveContent: false,
        likes: post.public_metrics?.like_count || undefined,
        replies: post.public_metrics?.reply_count || undefined,
        reposts: post.public_metrics?.retweet_count || undefined,
        views: post.public_metrics?.impression_count || undefined,
        quotes: post.public_metrics?.quote_count || undefined,
      };

      yield convertedPost;
      count++;
    }
  } catch (error) {
    console.error("Search error:", error);
    throw error;
  }
}

/**
 * Search for users using X API v2.
 * User search is limited in standard X API v2 -
 * searches for users mentioned in posts matching the query.
 *
 * @param query Search query
 * @param maxProfiles Maximum number of profiles to return
 * @param auth Authentication
 * @returns Async generator of profiles
 */
export async function* searchProfiles(
  query: string,
  maxProfiles: number,
  auth: XAuth
): AsyncGenerator<Profile, void> {
  const client = await auth.getV2Client();
  const userIds = new Set<string>();
  const profiles: Profile[] = [];

  try {
    // Search for posts and extract unique user IDs
    const searchIterator = await client.v2.search(query, {
      max_results: Math.min(maxProfiles * 2, 100), // Get more posts to find more users
      "tweet.fields": ["author_id"],
      "user.fields": [
        "id",
        "name",
        "username",
        "description",
        "profile_image_url",
        "public_metrics",
        "verified",
        "location",
        "created_at",
      ],
      expansions: ["author_id"],
    });

    for await (const post of searchIterator) {
      if (post.author_id) {
        userIds.add(post.author_id);
      }

      // Also get users from includes
      if (searchIterator.includes?.users) {
        for (const user of searchIterator.includes.users) {
          if (profiles.length < maxProfiles && user.id) {
            const profile: Profile = {
              userId: user.id,
              username: user.username || "",
              name: user.name || "",
              biography: user.description || "",
              avatar: user.profile_image_url || "",
              followersCount: user.public_metrics?.followers_count,
              followingCount: user.public_metrics?.following_count,
              isVerified: user.verified || false,
              location: user.location || "",
              joined: user.created_at ? new Date(user.created_at) : undefined,
            };
            profiles.push(profile);
          }
        }
      }

      if (profiles.length >= maxProfiles) break;
    }

    // Yield the profiles we found
    for (const profile of profiles) {
      yield profile;
    }
  } catch (error) {
    console.error("Profile search error:", error);
    throw error;
  }
}

/**
 * Fetch posts quoting a specific post
 *
 * @param quotedPostId The ID of the quoted post
 * @param maxPosts Maximum number of posts to return
 * @param auth Authentication
 * @returns Async generator of posts
 */
export async function* searchQuotedPosts(
  quotedPostId: string,
  maxPosts: number,
  auth: XAuth
): AsyncGenerator<Post, void> {
  // X API v2 doesn't have a direct endpoint for quote posts
  // We need to search for posts that reference this post
  const query = `url:"x.com/*/status/${quotedPostId}"`;

  yield* searchPosts(query, maxPosts, SearchMode.Latest, auth);
}
