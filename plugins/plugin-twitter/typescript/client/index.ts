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

// Client placeholder - actual implementation to be added
export interface ClientOptions {
  apiKey?: string;
  apiSecretKey?: string;
  accessToken?: string;
  accessTokenSecret?: string;
}

export class Client {
  constructor(_options: ClientOptions) {
    // Placeholder
  }
}

export class TwitterAuth {
  // Placeholder for auth handling
}

// API types
export interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
}

export interface User {
  id: string;
  name: string;
  username: string;
}

// Error types
export class TwitterAPIError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = "TwitterAPIError";
  }
}
