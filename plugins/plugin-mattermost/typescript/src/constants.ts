/**
 * Service name used for registration and lookup.
 */
export const MATTERMOST_SERVICE_NAME = "mattermost";

/**
 * Maximum message length for Mattermost posts (characters).
 */
export const MAX_MESSAGE_LENGTH = 16383;

/**
 * WebSocket reconnection delay in milliseconds.
 */
export const WS_RECONNECT_DELAY_MS = 2000;

/**
 * Default channel cache TTL in milliseconds.
 */
export const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default user cache TTL in milliseconds.
 */
export const USER_CACHE_TTL_MS = 10 * 60 * 1000;
