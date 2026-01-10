export const BLUESKY_SERVICE_NAME = 'bluesky';
export const BLUESKY_DEFAULT_SERVICE_URL = 'https://bsky.social';
export const BLUESKY_MAX_POST_LENGTH = 300;
export const BLUESKY_DEFAULT_POLL_INTERVAL = 60; // 60 seconds
export const BLUESKY_DEFAULT_POST_INTERVAL_MIN = 1800; // 30 minutes
export const BLUESKY_DEFAULT_POST_INTERVAL_MAX = 3600; // 60 minutes
export const BLUESKY_DEFAULT_ACTION_INTERVAL = 120; // 2 minutes
export const BLUESKY_DEFAULT_MAX_ACTIONS = 5;

// AT Protocol specific constants
export const AT_PROTOCOL_HANDLE_REGEX =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export const AT_PROTOCOL_DID_REGEX = /^did:([a-z]+):([a-zA-Z0-9._%-]+)$/;

// Chat/DM constants
export const BLUESKY_CHAT_SERVICE_DID = 'did:web:api.bsky.chat';

// Content types
export const BLUESKY_POST_COLLECTION = 'app.bsky.feed.post';
export const BLUESKY_REPOST_COLLECTION = 'app.bsky.feed.repost';
export const BLUESKY_LIKE_COLLECTION = 'app.bsky.feed.like';
export const BLUESKY_FOLLOW_COLLECTION = 'app.bsky.graph.follow';

// Error messages
export const ERROR_MESSAGES = {
  NOT_AUTHENTICATED: 'BlueSky client not authenticated',
  INVALID_HANDLE: 'Invalid BlueSky handle format',
  INVALID_DID: 'Invalid DID format',
  MISSING_CREDENTIALS: 'Missing BlueSky credentials',
  POST_TOO_LONG: `Post exceeds maximum length of ${BLUESKY_MAX_POST_LENGTH} characters`,
  RATE_LIMITED: 'Rate limited by BlueSky API',
  NETWORK_ERROR: 'Network error while communicating with BlueSky',
  SESSION_EXPIRED: 'BlueSky session expired',
  SERVICE_UNAVAILABLE: 'BlueSky service is temporarily unavailable',
} as const;

// Cache TTLs
export const CACHE_TTLS = {
  PROFILE: 3600000, // 1 hour
  TIMELINE: 300000, // 5 minutes
  POST: 1800000, // 30 minutes
  FOLLOWERS: 3600000, // 1 hour
  FOLLOWING: 3600000, // 1 hour
  NOTIFICATIONS: 300000, // 5 minutes
  CONVERSATIONS: 300000, // 5 minutes
} as const;

// Cache sizes
export const CACHE_SIZES = {
  PROFILE: 1000,
  TIMELINE: 500,
  POST: 10000,
  FOLLOWERS: 5000,
  FOLLOWING: 5000,
  NOTIFICATIONS: 1000,
  CONVERSATIONS: 100,
} as const;
