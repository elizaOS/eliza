/**
 * Common types for Twitter plugin API responses
 */

import type { Tweet } from "./tweets";
import type { Profile } from "./profile";

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

/**
 * Generic API result container
 */
export type RequestApiResult<T> =
  | { success: true; value: T }
  | { success: false; err: Error };

/**
 * Options for request transformation
 */
export interface FetchTransformOptions {
  /**
   * Transforms the request options before a request is made.
   */
  request: (
    ...args: [input: RequestInfo | URL, init?: RequestInit]
  ) =>
    | [input: RequestInfo | URL, init?: RequestInit]
    | Promise<[input: RequestInfo | URL, init?: RequestInit]>;

  /**
   * Transforms the response after a request completes.
   */
  response: (response: Response) => Response | Promise<Response>;
}
