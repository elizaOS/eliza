"""Shared LLM provider detection and configuration."""

# Provider → base URL mapping for OpenAI-compatible APIs
PROVIDER_URLS: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
}

# Provider → env var for API key
PROVIDER_KEY_VARS: dict[str, str] = {
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
}


def detect_provider(model_name: str) -> str:
    """Detect provider from model name prefix or known patterns.

    Priority: explicit prefix > known model families > default.
    """
    lower = model_name.lower()

    # Explicit prefix takes priority
    for prefix in ("groq/", "openrouter/", "openai/", "anthropic/"):
        if lower.startswith(prefix):
            return prefix.rstrip("/")

    # Known model families on specific providers
    if lower.startswith("gpt"):
        return "openai"
    if lower.startswith("claude"):
        return "anthropic"

    # Default: use openai (most compatible)
    return "openai"
