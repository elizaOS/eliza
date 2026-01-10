/**
 * Twitter/X API v2 Client
 *
 * Provides a clean interface to Twitter's API v2 for:
 * - Tweets (create, read, delete, like, retweet)
 * - Users (profiles, followers, following)
 * - Timelines (home, user, list)
 * - Search (tweets, users)
 * - Direct Messages (limited in v2)
 */

export { Client } from "./client";
export type { ClientOptions } from "./client";

export { TwitterAuth } from "./auth";

export * from "./tweets";
export * from "./profile";
export * from "./relationships";
export * from "./search";
export * from "./api-types";
export * from "./errors";
