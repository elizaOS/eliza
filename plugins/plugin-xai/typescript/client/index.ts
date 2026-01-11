/**
 * X API v2 Client
 *
 * Provides a clean interface to X's API v2 for:
 * - Posts (create, read, delete, like, repost)
 * - Users (profiles, followers, following)
 * - Timelines (home, user, list)
 * - Search (posts, users)
 * - Direct Messages (limited in v2)
 */

export * from "./api-types";
export { XAuth } from "./auth";
export type { ClientOptions } from "./client";
export { Client } from "./client";
export * from "./errors";
export * from "./posts";
export * from "./profile";
export * from "./relationships";
export * from "./search";
export type { QueryPostsResponse, QueryProfilesResponse } from "./types";
