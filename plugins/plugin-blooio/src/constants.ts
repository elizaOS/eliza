export const MESSAGE_CONSTANTS = {
  MAX_MESSAGES: 10,
  RECENT_MESSAGE_COUNT: 3,
  CHAT_HISTORY_COUNT: 5,
  INTEREST_DECAY_TIME: 5 * 60 * 1000, // 5 minutes
  PARTIAL_INTEREST_DECAY: 3 * 60 * 1000, // 3 minutes
  DEFAULT_SIMILARITY_THRESHOLD: 0.3,
  DEFAULT_SIMILARITY_THRESHOLD_FOLLOW_UPS: 0.2,
} as const;

export const MESSAGE_LENGTH_THRESHOLDS = {
  LOSE_INTEREST: 100,
  SHORT_MESSAGE: 10,
  VERY_SHORT_MESSAGE: 2,
  IGNORE_RESPONSE: 4,
} as const;

/**
 * An array of words or phrases that indicate losing interest or annoyance.
 * @type {readonly ["shut up", "stop", "please shut up", "shut up please", "dont talk", "silence", "stop talking", "be quiet", "hush", "wtf", "chill", "stfu", "stupid bot", "dumb bot", "stop responding", "god damn it", "god damn", "goddamnit", "can you not", "can you stop", "be quiet", "hate you", "hate this", "fuck up"]}
 */
export const LOSE_INTEREST_WORDS = [
  "shut up",
  "stop",
  "please shut up",
  "shut up please",
  "dont talk",
  "silence",
  "stop talking",
  "be quiet",
  "hush",
  "wtf",
  "chill",
  "stfu",
  "stupid bot",
  "dumb bot",
  "stop responding",
  "god damn it",
  "god damn",
  "goddamnit",
  "can you not",
  "can you stop",
  "be quiet",
  "hate you",
  "hate this",
  "fuck up",
] as const;

export const IGNORE_RESPONSE_WORDS = [
  "lol",
  "nm",
  "uh",
  "wtf",
  "stfu",
  "dumb",
  "jfc",
  "omg",
] as const;

export const BLOOIO_SERVICE_NAME = "blooio";

// Blooio constants
export const BLOOIO_CONSTANTS = {
  API_BASE_URL: "https://backend.blooio.com/v2/api",
  WEBHOOK_PATHS: {
    EVENTS: "/webhook",
  },
  SIGNATURE_TOLERANCE_SECONDS: 300,
  CACHE_TTL: {
    CONVERSATION: 3600, // 1 hour
  },
} as const;

// Error messages
export const ERROR_MESSAGES = {
  INVALID_CHAT_ID:
    "Invalid chat identifier. Use E.164 (+15551234567), email, or group id (grp_xxxx).",
  MISSING_API_KEY: "Blooio API key not configured",
  MISSING_WEBHOOK_URL: "Blooio webhook URL not configured",
  WEBHOOK_VALIDATION_FAILED: "Failed to validate Blooio webhook signature",
} as const;
