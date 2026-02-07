/// Service name used for registration.
pub const SERVICE_NAME: &str = "blooio";

/// Default Blooio API base URL.
pub const DEFAULT_API_BASE_URL: &str = "https://backend.blooio.com/v2/api";

/// Default webhook server port.
pub const DEFAULT_WEBHOOK_PORT: u16 = 3001;

/// Default webhook path for events.
pub const WEBHOOK_PATH_EVENTS: &str = "/webhook";

/// Signature timestamp tolerance in seconds.
pub const SIGNATURE_TOLERANCE_SECONDS: u64 = 300;

/// Maximum number of conversation history entries per chat.
pub const MAX_CONVERSATION_HISTORY: usize = 50;

/// Conversation cache TTL in seconds.
pub const CONVERSATION_CACHE_TTL: u64 = 3600;

/// Error messages used across the plugin.
pub mod error_messages {
    pub const INVALID_CHAT_ID: &str =
        "Invalid chat identifier. Use E.164 (+15551234567), email, or group id (grp_xxxx).";
    pub const MISSING_API_KEY: &str = "Blooio API key not configured";
    pub const MISSING_WEBHOOK_URL: &str = "Blooio webhook URL not configured";
    pub const WEBHOOK_VALIDATION_FAILED: &str =
        "Failed to validate Blooio webhook signature";
    pub const SERVICE_NOT_AVAILABLE: &str = "Blooio service is not available";
    pub const NO_VALID_RECIPIENT: &str = "No valid chat identifier found in message";
}
