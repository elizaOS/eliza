/**
 * Common types for X plugin API responses
 */

/**
 * Generic API result container
 * Defined here to avoid circular dependency with profile.ts and posts.ts
 */
export type RequestApiResult<T> = { success: true; value: T } | { success: false; err: Error };

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

// QueryPostsResponse and QueryProfilesResponse are in types.ts - import from there
