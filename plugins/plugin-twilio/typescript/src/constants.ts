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

export const TWILIO_SERVICE_NAME = "twilio";

// Twilio constants
export const TWILIO_CONSTANTS = {
  // Message limits
  SMS_MAX_LENGTH: 1600,
  MMS_MAX_MEDIA_SIZE: 5242880, // 5MB
  MMS_MAX_MEDIA_COUNT: 10,

  // Voice constants
  DEFAULT_VOICE: "alice",
  DEFAULT_LANGUAGE: "en-US",
  VOICE_STREAM_TIMEOUT: 300000, // 5 minutes

  // API endpoints
  API_BASE_URL: "https://api.twilio.com",

  // Webhook paths
  WEBHOOK_PATHS: {
    SMS: "/webhooks/twilio/sms",
    VOICE: "/webhooks/twilio/voice",
    STATUS: "/webhooks/twilio/status",
    VOICE_STREAM: "/webhooks/twilio/voice-stream",
  },

  // TwiML templates
  TWIML: {
    DEFAULT_VOICE_RESPONSE: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Hello from Eliza AI assistant. How can I help you today?</Say>
    <Pause length="1"/>
</Response>`,

    STREAM_RESPONSE: (streamUrl: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Start>
        <Stream url="${streamUrl}" />
    </Start>
    <Say>Please wait while I connect you to the AI assistant.</Say>
    <Pause length="60"/>
</Response>`,
  },

  // Rate limits
  RATE_LIMITS: {
    SMS_PER_SECOND: 1,
    CALLS_PER_SECOND: 1,
    WEBHOOK_TIMEOUT: 15000, // 15 seconds
  },

  // Cache TTL
  CACHE_TTL: {
    CONVERSATION: 3600, // 1 hour
    MEDIA: 86400, // 24 hours
    CALL_STATE: 1800, // 30 minutes
  },
} as const;

// Audio formats for voice
export const AUDIO_FORMATS = {
  INPUT: "audio/x-mulaw",
  OUTPUT: "audio/x-mulaw",
  SAMPLE_RATE: 8000,
  CHANNELS: 1,
} as const;

// Supported media types
export const SUPPORTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
] as const;

// Error messages
export const ERROR_MESSAGES = {
  INVALID_PHONE_NUMBER: "Invalid phone number format. Please use E.164 format (e.g., +18885551212)",
  MISSING_CREDENTIALS: "Twilio credentials not configured",
  WEBHOOK_VALIDATION_FAILED: "Failed to validate Twilio webhook signature",
  RATE_LIMIT_EXCEEDED: "Rate limit exceeded. Please try again later.",
  MEDIA_TOO_LARGE: "Media file too large. Maximum size is 5MB",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
} as const;
