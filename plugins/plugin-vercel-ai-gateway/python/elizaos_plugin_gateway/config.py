"""
Vercel AI Gateway Plugin Configuration

Configuration management with environment variable support.
"""

from __future__ import annotations

import os

from pydantic import BaseModel, Field


class GatewayConfig(BaseModel):
    """Vercel AI Gateway client configuration."""

    api_key: str = Field(..., min_length=1, description="API key for authentication")
    base_url: str = Field(
        default="https://ai-gateway.vercel.sh/v1", description="API base URL"
    )
    small_model: str = Field(default="gpt-5-mini", description="Small model identifier")
    large_model: str = Field(default="gpt-5", description="Large model identifier")
    embedding_model: str = Field(
        default="text-embedding-3-small", description="Embedding model identifier"
    )
    embedding_dimensions: int = Field(default=1536, ge=1, description="Embedding dimensions")
    image_model: str = Field(default="dall-e-3", description="Image generation model")
    timeout: float = Field(default=60.0, ge=1.0, description="Request timeout in seconds")

    @classmethod
    def from_env(cls) -> "GatewayConfig":
        """
        Create configuration from environment variables.

        Environment variables:
            AI_GATEWAY_API_KEY or AIGATEWAY_API_KEY or VERCEL_OIDC_TOKEN: API key (required)
            AI_GATEWAY_BASE_URL: Base URL
            AI_GATEWAY_SMALL_MODEL: Small model
            AI_GATEWAY_LARGE_MODEL: Large model
            AI_GATEWAY_EMBEDDING_MODEL: Embedding model
            AI_GATEWAY_EMBEDDING_DIMENSIONS: Embedding dimensions
            AI_GATEWAY_IMAGE_MODEL: Image model
            AI_GATEWAY_TIMEOUT_MS: Timeout in milliseconds

        Returns:
            GatewayConfig instance

        Raises:
            ValueError: If API key is not found
        """
        api_key = (
            os.environ.get("AI_GATEWAY_API_KEY")
            or os.environ.get("AIGATEWAY_API_KEY")
            or os.environ.get("VERCEL_OIDC_TOKEN")
        )

        if not api_key:
            raise ValueError(
                "AI_GATEWAY_API_KEY, AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN "
                "must be set in environment variables"
            )

        kwargs: dict[str, str | int | float] = {"api_key": api_key}

        if base_url := os.environ.get("AI_GATEWAY_BASE_URL"):
            kwargs["base_url"] = base_url

        if small_model := os.environ.get("AI_GATEWAY_SMALL_MODEL"):
            kwargs["small_model"] = small_model

        if large_model := os.environ.get("AI_GATEWAY_LARGE_MODEL"):
            kwargs["large_model"] = large_model

        if embedding_model := os.environ.get("AI_GATEWAY_EMBEDDING_MODEL"):
            kwargs["embedding_model"] = embedding_model

        if dims := os.environ.get("AI_GATEWAY_EMBEDDING_DIMENSIONS"):
            kwargs["embedding_dimensions"] = int(dims)

        if image_model := os.environ.get("AI_GATEWAY_IMAGE_MODEL"):
            kwargs["image_model"] = image_model

        if timeout_ms := os.environ.get("AI_GATEWAY_TIMEOUT_MS"):
            kwargs["timeout"] = float(timeout_ms) / 1000.0

        return cls(**kwargs)


# Models that don't support temperature/sampling parameters (reasoning models)
NO_TEMPERATURE_MODELS = frozenset({
    "o1",
    "o1-preview",
    "o1-mini",
    "o3",
    "o3-mini",
    "gpt-5",
    "gpt-5-mini",
})


def model_supports_temperature(model: str) -> bool:
    """Check if a model supports temperature parameter."""
    model_lower = model.lower()
    for no_temp_model in NO_TEMPERATURE_MODELS:
        if no_temp_model in model_lower:
            return False
    return True

