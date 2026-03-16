"""Constants for the Moltbook plugin."""

# Service name for registration
MOLTBOOK_SERVICE_NAME = "moltbook"

# External service URLs
URLS = {
    "moltbook": "https://www.moltbook.com/api/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}

# Default autonomy settings
AUTONOMY_DEFAULTS = {
    "min_interval_ms": 30_000,
    "max_interval_ms": 90_000,
    "max_tool_calls": 5,
    "default_model": "deepseek/deepseek-chat-v3-0324",
}

# Content limits
CONTENT_LIMITS = {
    "default_browse_limit": 10,
    "max_content_length": 10_000,
    "max_title_length": 300,
    "max_comment_length": 5_000,
}

# Default submolt (subreddit equivalent)
DEFAULT_SUBMOLT = "iq"
