"""Constants used across the Blooio plugin."""

SERVICE_NAME: str = "blooio"

DEFAULT_API_BASE_URL: str = "https://backend.blooio.com/v2/api"

DEFAULT_WEBHOOK_PORT: int = 3001

WEBHOOK_PATH_EVENTS: str = "/webhook"

SIGNATURE_TOLERANCE_SECONDS: int = 300

MAX_CONVERSATION_HISTORY: int = 50

CONVERSATION_CACHE_TTL: int = 3600


# -- Error messages -----------------------------------------------------------

INVALID_CHAT_ID: str = (
    "Invalid chat identifier. Use E.164 (+15551234567), email, or group id (grp_xxxx)."
)
MISSING_API_KEY: str = "Blooio API key not configured"
MISSING_WEBHOOK_URL: str = "Blooio webhook URL not configured"
WEBHOOK_VALIDATION_FAILED: str = "Failed to validate Blooio webhook signature"
SERVICE_NOT_AVAILABLE: str = "Blooio service is not available"
NO_VALID_RECIPIENT: str = "No valid chat identifier found in message"
