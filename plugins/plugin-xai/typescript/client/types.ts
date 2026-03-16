/**
 * Common types for X plugin API responses.
 * Uses type-only imports to avoid circular dependencies.
 * Profile and Post interfaces are defined in profile.ts and posts.ts.
 */

import type { Post } from "./posts";
import type { Profile } from "./profile";

/**
 * Response for paginated posts queries
 */
export interface QueryPostsResponse {
  posts: Post[];
  next?: string;
  previous?: string;
}

/**
 * Response for paginated profiles queries
 */
export interface QueryProfilesResponse {
  profiles: Profile[];
  next?: string;
  previous?: string;
}
