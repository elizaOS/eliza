/**
 * Common types for Twitter plugin API responses
 *
 * Note: These types use type-only imports to avoid circular dependencies.
 * The actual Profile and Tweet interfaces are defined in profile.ts and tweets.ts.
 */

import type { Profile } from "./profile";
import type { Tweet } from "./tweets";

/**
 * Response for paginated tweets queries
 */
export interface QueryTweetsResponse {
  tweets: Tweet[];
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
