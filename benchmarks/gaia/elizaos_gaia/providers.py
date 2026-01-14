"""
Multi-Provider Model System for GAIA Benchmark

Supports multiple LLM providers:
- Groq (default: llama-3.1-8b-instant)
- OpenAI
- Anthropic
- Ollama
- LocalAI
- OpenRouter
- Google GenAI
- XAI (Grok)

Each provider has its own API format and configuration.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class ModelProvider(str, Enum):
    """Supported model providers."""
    GROQ = "groq"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    OLLAMA = "ollama"
    LOCALAI = "localai"
    OPENROUTER = "openrouter"
    GOOGLE = "google"
    XAI = "xai"


# Default models for each provider
DEFAULT_MODELS: dict[ModelProvider, str] = {
    ModelProvider.GROQ: "llama-3.1-8b-instant",
    ModelProvider.OPENAI: "gpt-5",
    ModelProvider.ANTHROPIC: "claude-3-5-sonnet-20241022",
    ModelProvider.OLLAMA: "llama3.2:latest",
    ModelProvider.LOCALAI: "gpt-4",
    ModelProvider.OPENROUTER: "meta-llama/llama-3.1-8b-instruct",
    ModelProvider.GOOGLE: "gemini-2.0-flash-exp",
    ModelProvider.XAI: "grok-2-latest",
}

# Popular models per provider
SUPPORTED_MODELS: dict[ModelProvider, list[str]] = {
    ModelProvider.GROQ: [
        # Llama models
        "llama-3.1-8b-instant",       # Fast, good quality - DEFAULT
        "llama-3.3-70b-versatile",    # Best Llama on Groq
        "llama-3.1-70b-versatile",
        "llama-3.2-90b-vision-preview",  # Vision capable
        "llama-3.2-11b-vision-preview",
        # Mixtral
        "mixtral-8x7b-32768",
        # Qwen (if available)
        "qwen2.5-32b",  # May need OpenRouter for this
    ],
    ModelProvider.OPENAI: [
        "gpt-5",
        "gpt-5-mini",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo",
        "o1-preview",
        "o1-mini",
    ],
    ModelProvider.ANTHROPIC: [
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
        "claude-3-sonnet-20240229",
        "claude-3-haiku-20240307",
    ],
    ModelProvider.OLLAMA: [
        "llama3.2:latest",
        "llama3.1:70b",
        "llama3.1:8b",
        "qwen2.5:32b",
        "qwen2.5:72b",
        "mistral:latest",
        "mixtral:latest",
        "codellama:latest",
        "phi3:latest",
        "gemma2:latest",
    ],
    ModelProvider.LOCALAI: [
        "gpt-4",
        "gpt-3.5-turbo",
        "llama-3.1-8b",
        "llama-3.1-70b",
    ],
    ModelProvider.OPENROUTER: [
        # Llama
        "meta-llama/llama-3.1-8b-instruct",
        "meta-llama/llama-3.1-70b-instruct",
        "meta-llama/llama-3.1-405b-instruct",
        "meta-llama/llama-3.3-70b-instruct",
        # Qwen
        "qwen/qwen-2.5-32b-instruct",
        "qwen/qwen-2.5-72b-instruct",
        "qwen/qwq-32b-preview",
        # Mistral
        "mistralai/mistral-large",
        "mistralai/mixtral-8x22b-instruct",
        # DeepSeek
        "deepseek/deepseek-chat",
        "deepseek/deepseek-r1",
        # OpenAI through router
        "openai/gpt-5",
        "openai/o1-preview",
        # Anthropic through router
        "anthropic/claude-3.5-sonnet",
    ],
    ModelProvider.GOOGLE: [
        "gemini-2.0-flash-exp",
        "gemini-1.5-pro",
        "gemini-1.5-flash",
        "gemini-1.5-flash-8b",
    ],
    ModelProvider.XAI: [
        "grok-2-latest",
        "grok-2-vision-1212",
        "grok-beta",
    ],
}

# API base URLs
API_BASES: dict[ModelProvider, str] = {
    ModelProvider.GROQ: "https://api.groq.com/openai/v1",
    ModelProvider.OPENAI: "https://api.openai.com/v1",
    ModelProvider.ANTHROPIC: "https://api.anthropic.com/v1",
    ModelProvider.OLLAMA: "http://localhost:11434/api",
    ModelProvider.LOCALAI: "http://localhost:8080/v1",
    ModelProvider.OPENROUTER: "https://openrouter.ai/api/v1",
    ModelProvider.GOOGLE: "https://generativelanguage.googleapis.com/v1beta",
    ModelProvider.XAI: "https://api.x.ai/v1",
}

# Environment variable names for API keys
API_KEY_ENV_VARS: dict[ModelProvider, str] = {
    ModelProvider.GROQ: "GROQ_API_KEY",
    ModelProvider.OPENAI: "OPENAI_API_KEY",
    ModelProvider.ANTHROPIC: "ANTHROPIC_API_KEY",
    ModelProvider.OLLAMA: "",  # No key needed for local
    ModelProvider.LOCALAI: "LOCALAI_API_KEY",
    ModelProvider.OPENROUTER: "OPENROUTER_API_KEY",
    ModelProvider.GOOGLE: "GOOGLE_API_KEY",
    ModelProvider.XAI: "XAI_API_KEY",
}


@dataclass
class ModelConfig:
    """Configuration for a specific model."""
    provider: ModelProvider
    model_name: str
    api_key: str | None = None
    api_base: str | None = None
    temperature: float = 0.0
    max_tokens: int = 4096
    # Provider-specific settings
    extra_headers: dict[str, str] = field(default_factory=dict)
    extra_params: dict[str, str | int | float | bool] = field(default_factory=dict)

    @property
    def effective_api_base(self) -> str:
        """Get the effective API base URL."""
        if self.api_base:
            return self.api_base
        return API_BASES.get(self.provider, "")

    @property
    def effective_api_key(self) -> str | None:
        """Get the effective API key from config or environment."""
        if self.api_key:
            return self.api_key
        env_var = API_KEY_ENV_VARS.get(self.provider, "")
        if env_var:
            return os.getenv(env_var)
        return None

    @classmethod
    def from_model_string(cls, model_string: str, **kwargs: str | int | float | bool) -> ModelConfig:
        """
        Create ModelConfig from a model string.

        Supports formats:
        - "model_name" (uses default provider based on model)
        - "provider/model_name" (explicit provider)
        - "provider:model_name" (alternate syntax)

        Examples:
        - "llama-3.1-8b-instant" -> Groq
        - "gpt-5" -> OpenAI
        - "groq/llama-3.1-8b-instant" -> Groq
        - "openrouter/qwen/qwen-2.5-32b-instruct" -> OpenRouter
        """
        # Check for explicit provider prefix
        if "/" in model_string:
            parts = model_string.split("/", 1)
            provider_str = parts[0].lower()
            model_name = parts[1]

            # Handle OpenRouter's nested paths
            if provider_str == "openrouter" and "/" in model_name:
                # Keep the full path for OpenRouter
                model_name = parts[1]
            elif provider_str in [p.value for p in ModelProvider]:
                pass  # Use as-is
            else:
                # Might be a full model path, try to infer
                model_name = model_string
                provider_str = cls._infer_provider(model_string).value
        elif ":" in model_string:
            parts = model_string.split(":", 1)
            provider_str = parts[0].lower()
            model_name = parts[1]
        else:
            model_name = model_string
            provider_str = cls._infer_provider(model_string).value

        try:
            provider = ModelProvider(provider_str)
        except ValueError:
            # Default to OpenRouter for unknown providers
            provider = ModelProvider.OPENROUTER
            model_name = model_string

        # Build config with kwargs
        config_kwargs: dict[str, str | int | float | bool | ModelProvider | None] = {
            "provider": provider,
            "model_name": model_name,
        }

        # Map common kwargs
        if "temperature" in kwargs:
            config_kwargs["temperature"] = float(kwargs["temperature"])
        if "max_tokens" in kwargs:
            config_kwargs["max_tokens"] = int(kwargs["max_tokens"])
        if "api_key" in kwargs:
            config_kwargs["api_key"] = str(kwargs["api_key"])
        if "api_base" in kwargs:
            config_kwargs["api_base"] = str(kwargs["api_base"])

        return cls(**config_kwargs)  # type: ignore[arg-type]

    @staticmethod
    def _infer_provider(model_name: str) -> ModelProvider:
        """Infer provider from model name."""
        model_lower = model_name.lower()

        # Groq models (default for Llama instant models)
        if "instant" in model_lower and "llama" in model_lower:
            return ModelProvider.GROQ
        if model_lower in [m.lower() for m in SUPPORTED_MODELS[ModelProvider.GROQ]]:
            return ModelProvider.GROQ

        # OpenAI models
        if model_lower.startswith(("gpt-", "o1-", "o1")):
            return ModelProvider.OPENAI

        # Anthropic models
        if model_lower.startswith("claude"):
            return ModelProvider.ANTHROPIC

        # Google models
        if model_lower.startswith("gemini"):
            return ModelProvider.GOOGLE

        # XAI models
        if model_lower.startswith("grok"):
            return ModelProvider.XAI

        # Ollama local models (check for :tag format)
        if ":" in model_lower:
            return ModelProvider.OLLAMA

        # Check OpenRouter models
        for model in SUPPORTED_MODELS[ModelProvider.OPENROUTER]:
            if model_lower in model.lower():
                return ModelProvider.OPENROUTER

        # Default to Groq (fastest for open models)
        return ModelProvider.GROQ


async def call_provider(
    config: ModelConfig,
    messages: list[dict[str, str]],
) -> tuple[str, int]:
    """
    Call the configured provider and return (response_text, token_count).

    Args:
        config: Model configuration
        messages: List of message dicts with 'role' and 'content'

    Returns:
        Tuple of (response_text, approximate_token_count)
    """

    api_key = config.effective_api_key

    # Check API key requirement
    if config.provider not in (ModelProvider.OLLAMA,) and not api_key:
        env_var = API_KEY_ENV_VARS.get(config.provider, "API_KEY")
        raise ValueError(
            f"{config.provider.value.upper()} API key required. "
            f"Set {env_var} environment variable."
        )

    # Route to provider-specific handler
    if config.provider == ModelProvider.ANTHROPIC:
        return await _call_anthropic(config, messages, api_key)
    elif config.provider == ModelProvider.OLLAMA:
        return await _call_ollama(config, messages)
    elif config.provider == ModelProvider.GOOGLE:
        return await _call_google(config, messages, api_key)
    else:
        # OpenAI-compatible providers (OpenAI, Groq, OpenRouter, LocalAI, XAI)
        return await _call_openai_compatible(config, messages, api_key)


async def _call_openai_compatible(
    config: ModelConfig,
    messages: list[dict[str, str]],
    api_key: str | None,
) -> tuple[str, int]:
    """Call OpenAI-compatible API (OpenAI, Groq, OpenRouter, LocalAI, XAI)."""
    import aiohttp

    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate",  # Avoid brotli which aiohttp can't decode
    }

    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    # Add provider-specific headers
    if config.provider == ModelProvider.OPENROUTER:
        headers["HTTP-Referer"] = "https://elizaos.ai"
        headers["X-Title"] = "ElizaOS GAIA Benchmark"

    headers.update(config.extra_headers)

    payload: dict[str, str | int | float | list[dict[str, str]]] = {
        "model": config.model_name,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
    }
    payload.update(config.extra_params)  # type: ignore[arg-type]

    api_url = f"{config.effective_api_base}/chat/completions"

    async with aiohttp.ClientSession() as session:
        async with session.post(
            api_url,
            headers=headers,
            json=payload,
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise RuntimeError(
                    f"{config.provider.value} API error ({response.status}): {error_text}"
                )

            data = await response.json()

    # Extract response
    choices = data.get("choices", [])
    if not choices:
        raise ValueError(f"No choices in {config.provider.value} response")

    message = choices[0].get("message", {})
    content = message.get("content", "")

    usage = data.get("usage", {})
    tokens = usage.get("total_tokens", 0)

    return content, tokens


async def _call_anthropic(
    config: ModelConfig,
    messages: list[dict[str, str]],
    api_key: str | None,
) -> tuple[str, int]:
    """Call Anthropic API with Messages format."""
    import aiohttp

    # Extract system message if present
    system_content = ""
    user_messages: list[dict[str, str]] = []

    for msg in messages:
        if msg["role"] == "system":
            system_content = msg["content"]
        else:
            user_messages.append({
                "role": msg["role"],
                "content": msg["content"],
            })

    headers = {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip, deflate",  # Avoid brotli
        "x-api-key": api_key or "",
        "anthropic-version": "2023-06-01",
    }
    headers.update(config.extra_headers)

    payload: dict[str, str | int | float | list[dict[str, str]]] = {
        "model": config.model_name,
        "messages": user_messages,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
    }

    if system_content:
        payload["system"] = system_content

    payload.update(config.extra_params)  # type: ignore[arg-type]

    api_url = f"{config.effective_api_base}/messages"

    async with aiohttp.ClientSession() as session:
        async with session.post(
            api_url,
            headers=headers,
            json=payload,
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise RuntimeError(f"Anthropic API error ({response.status}): {error_text}")

            data = await response.json()

    # Extract response
    content_blocks = data.get("content", [])
    text_content = ""
    for block in content_blocks:
        if block.get("type") == "text":
            text_content += block.get("text", "")

    usage = data.get("usage", {})
    tokens = usage.get("input_tokens", 0) + usage.get("output_tokens", 0)

    return text_content, tokens


async def _call_ollama(
    config: ModelConfig,
    messages: list[dict[str, str]],
) -> tuple[str, int]:
    """Call Ollama local API."""
    import aiohttp

    payload = {
        "model": config.model_name,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": config.temperature,
            "num_predict": config.max_tokens,
        },
    }

    api_url = f"{config.effective_api_base}/chat"

    async with aiohttp.ClientSession() as session:
        async with session.post(
            api_url,
            json=payload,
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise RuntimeError(f"Ollama API error ({response.status}): {error_text}")

            data = await response.json()

    message = data.get("message", {})
    content = message.get("content", "")

    # Ollama doesn't return token counts, estimate
    tokens = len(content.split()) * 2  # Rough estimate

    return content, tokens


async def _call_google(
    config: ModelConfig,
    messages: list[dict[str, str]],
    api_key: str | None,
) -> tuple[str, int]:
    """Call Google GenAI API."""
    import aiohttp

    # Convert messages to Google format
    contents: list[dict[str, str | list[dict[str, str]]]] = []
    system_instruction = ""

    for msg in messages:
        if msg["role"] == "system":
            system_instruction = msg["content"]
        elif msg["role"] == "user":
            contents.append({
                "role": "user",
                "parts": [{"text": msg["content"]}],
            })
        elif msg["role"] == "assistant":
            contents.append({
                "role": "model",
                "parts": [{"text": msg["content"]}],
            })

    payload: dict[str, str | int | float | list[dict[str, str | list[dict[str, str]]]] | dict[str, int | float]] = {
        "contents": contents,
        "generationConfig": {
            "temperature": config.temperature,
            "maxOutputTokens": config.max_tokens,
        },
    }

    if system_instruction:
        payload["systemInstruction"] = {
            "parts": [{"text": system_instruction}],
        }

    api_url = (
        f"{config.effective_api_base}/models/{config.model_name}:generateContent"
        f"?key={api_key}"
    )

    async with aiohttp.ClientSession() as session:
        async with session.post(
            api_url,
            headers={
                "Content-Type": "application/json",
                "Accept-Encoding": "gzip, deflate",  # Avoid brotli
            },
            json=payload,
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise RuntimeError(f"Google API error ({response.status}): {error_text}")

            data = await response.json()

    # Extract response
    candidates = data.get("candidates", [])
    if not candidates:
        raise ValueError("No candidates in Google response")

    content = candidates[0].get("content", {})
    parts = content.get("parts", [])
    text = "".join(p.get("text", "") for p in parts)

    usage = data.get("usageMetadata", {})
    tokens = usage.get("totalTokenCount", 0)

    return text, tokens


def get_available_providers() -> list[str]:
    """Get list of providers with available API keys."""
    available = []
    for provider in ModelProvider:
        env_var = API_KEY_ENV_VARS.get(provider, "")
        if not env_var or os.getenv(env_var):
            available.append(provider.value)
    return available


def get_default_config() -> ModelConfig:
    """
    Get default model configuration.

    Priority:
    1. Groq with llama-3.1-8b-instant (if GROQ_API_KEY set)
    2. OpenAI with gpt-5 (if OPENAI_API_KEY set)
    3. Ollama with llama3.2:latest (always available locally)
    """
    # Check Groq first (preferred default)
    if os.getenv("GROQ_API_KEY"):
        return ModelConfig(
            provider=ModelProvider.GROQ,
            model_name="llama-3.1-8b-instant",
        )

    # Check OpenAI
    if os.getenv("OPENAI_API_KEY"):
        return ModelConfig(
            provider=ModelProvider.OPENAI,
            model_name="gpt-5",
        )

    # Check Anthropic
    if os.getenv("ANTHROPIC_API_KEY"):
        return ModelConfig(
            provider=ModelProvider.ANTHROPIC,
            model_name="claude-3-5-sonnet-20241022",
        )

    # Check OpenRouter
    if os.getenv("OPENROUTER_API_KEY"):
        return ModelConfig(
            provider=ModelProvider.OPENROUTER,
            model_name="meta-llama/llama-3.1-8b-instruct",
        )

    # Fallback to Ollama (local)
    return ModelConfig(
        provider=ModelProvider.OLLAMA,
        model_name="llama3.2:latest",
    )


def list_models(provider: ModelProvider | None = None) -> dict[str, list[str]]:
    """List available models, optionally filtered by provider."""
    if provider:
        return {provider.value: SUPPORTED_MODELS.get(provider, [])}
    return {p.value: models for p, models in SUPPORTED_MODELS.items()}


# Convenience presets for common configurations
PRESETS: dict[str, ModelConfig] = {
    # Groq presets (fastest)
    "groq-fast": ModelConfig(
        provider=ModelProvider.GROQ,
        model_name="llama-3.1-8b-instant",
    ),
    "groq-best": ModelConfig(
        provider=ModelProvider.GROQ,
        model_name="llama-3.3-70b-versatile",
    ),

    # OpenAI presets
    "openai-fast": ModelConfig(
        provider=ModelProvider.OPENAI,
        model_name="gpt-5-mini",
    ),
    "openai-best": ModelConfig(
        provider=ModelProvider.OPENAI,
        model_name="gpt-5",
    ),
    "openai-reasoning": ModelConfig(
        provider=ModelProvider.OPENAI,
        model_name="o1-preview",
    ),

    # Anthropic presets
    "anthropic-fast": ModelConfig(
        provider=ModelProvider.ANTHROPIC,
        model_name="claude-3-5-haiku-20241022",
    ),
    "anthropic-best": ModelConfig(
        provider=ModelProvider.ANTHROPIC,
        model_name="claude-3-5-sonnet-20241022",
    ),

    # Open-source via OpenRouter
    "qwen-32b": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_name="qwen/qwen-2.5-32b-instruct",
    ),
    "qwen-72b": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_name="qwen/qwen-2.5-72b-instruct",
    ),
    "llama-405b": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_name="meta-llama/llama-3.1-405b-instruct",
    ),
    "deepseek-r1": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_name="deepseek/deepseek-r1",
    ),

    # Google presets
    "gemini-fast": ModelConfig(
        provider=ModelProvider.GOOGLE,
        model_name="gemini-2.0-flash-exp",
    ),
    "gemini-best": ModelConfig(
        provider=ModelProvider.GOOGLE,
        model_name="gemini-1.5-pro",
    ),

    # XAI presets
    "grok": ModelConfig(
        provider=ModelProvider.XAI,
        model_name="grok-2-latest",
    ),

    # Local presets
    "ollama-llama": ModelConfig(
        provider=ModelProvider.OLLAMA,
        model_name="llama3.2:latest",
    ),
    "ollama-qwen": ModelConfig(
        provider=ModelProvider.OLLAMA,
        model_name="qwen2.5:32b",
    ),
}
