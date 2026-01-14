"""
BFCL Model Provider Configuration

Comprehensive support for multiple LLM providers:
- Groq (default, with llama-3.1-8b-instant)
- OpenAI
- Anthropic
- Google GenAI
- OpenRouter
- XAI (Grok)
- Ollama (local)
- LocalAI (local GGUF models)

Configuration is via environment variables, with sensible defaults.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class ModelProvider(str, Enum):
    """Supported model providers."""
    GROQ = "groq"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE_GENAI = "google-genai"
    OPENROUTER = "openrouter"
    XAI = "xai"
    OLLAMA = "ollama"
    LOCAL_AI = "local-ai"


@dataclass
class ModelConfig:
    """Configuration for a specific model."""
    provider: ModelProvider
    model_id: str
    display_name: str
    is_default: bool = False
    max_tokens: int = 4096
    temperature: float = 0.0  # Low temp for function calling accuracy
    supports_function_calling: bool = True
    cost_per_1k_tokens: Optional[float] = None  # For cost tracking
    
    
@dataclass 
class ProviderConfig:
    """Configuration for a model provider."""
    provider: ModelProvider
    api_key_env: str
    base_url_env: Optional[str] = None
    default_base_url: Optional[str] = None
    small_model: str = ""
    large_model: str = ""
    is_local: bool = False
    priority: int = 0  # Higher = preferred when multiple available


# Default model configurations
# Groq is the default provider with llama-3.1-8b-instant as the default model
PROVIDER_CONFIGS: dict[ModelProvider, ProviderConfig] = {
    ModelProvider.GROQ: ProviderConfig(
        provider=ModelProvider.GROQ,
        api_key_env="GROQ_API_KEY",
        base_url_env="GROQ_BASE_URL",
        default_base_url="https://api.groq.com/openai/v1",
        small_model="llama-3.1-8b-instant",  # Default - fast and efficient
        large_model="llama-3.3-70b-versatile",  # For complex tasks
        priority=100,  # Highest priority - our default
    ),
    ModelProvider.OPENAI: ProviderConfig(
        provider=ModelProvider.OPENAI,
        api_key_env="OPENAI_API_KEY",
        base_url_env="OPENAI_BASE_URL",
        default_base_url="https://api.openai.com/v1",
        small_model="gpt-5-mini",
        large_model="gpt-5",
        priority=90,
    ),
    ModelProvider.ANTHROPIC: ProviderConfig(
        provider=ModelProvider.ANTHROPIC,
        api_key_env="ANTHROPIC_API_KEY",
        base_url_env="ANTHROPIC_BASE_URL",
        default_base_url="https://api.anthropic.com",
        small_model="claude-3-5-haiku-latest",
        large_model="claude-sonnet-4-20250514",
        priority=85,
    ),
    ModelProvider.GOOGLE_GENAI: ProviderConfig(
        provider=ModelProvider.GOOGLE_GENAI,
        api_key_env="GOOGLE_GENERATIVE_AI_API_KEY",
        base_url_env="GOOGLE_GENAI_BASE_URL",
        small_model="gemini-2.0-flash",
        large_model="gemini-2.5-pro",
        priority=80,
    ),
    ModelProvider.OPENROUTER: ProviderConfig(
        provider=ModelProvider.OPENROUTER,
        api_key_env="OPENROUTER_API_KEY",
        base_url_env="OPENROUTER_BASE_URL",
        default_base_url="https://openrouter.ai/api/v1",
        # OpenRouter gives access to many models
        small_model="meta-llama/llama-3.1-8b-instruct",  # Same as Groq default
        large_model="meta-llama/llama-3.3-70b-instruct",
        priority=70,
    ),
    ModelProvider.XAI: ProviderConfig(
        provider=ModelProvider.XAI,
        api_key_env="XAI_API_KEY",
        base_url_env="XAI_BASE_URL",
        default_base_url="https://api.x.ai/v1",
        small_model="grok-3-mini",
        large_model="grok-3",
        priority=75,
    ),
    ModelProvider.OLLAMA: ProviderConfig(
        provider=ModelProvider.OLLAMA,
        api_key_env="",  # No API key needed
        base_url_env="OLLAMA_BASE_URL",
        default_base_url="http://localhost:11434",
        small_model="llama3.1:8b",
        large_model="llama3.1:70b",
        is_local=True,
        priority=50,
    ),
    ModelProvider.LOCAL_AI: ProviderConfig(
        provider=ModelProvider.LOCAL_AI,
        api_key_env="",  # No API key needed
        base_url_env="LOCAL_AI_BASE_URL",
        small_model="DeepHermes-3-Llama-3-3B-Preview-q4.gguf",
        large_model="DeepHermes-3-Llama-3-8B-q4.gguf",
        is_local=True,
        priority=40,
    ),
}


# Supported models with their configurations
# These are curated models known to work well with function calling
SUPPORTED_MODELS: dict[str, ModelConfig] = {
    # Groq models (default provider)
    "groq/llama-3.1-8b-instant": ModelConfig(
        provider=ModelProvider.GROQ,
        model_id="llama-3.1-8b-instant",
        display_name="Llama 3.1 8B Instant (Groq)",
        is_default=True,  # This is our default model
        max_tokens=8192,
        cost_per_1k_tokens=0.00005,
    ),
    "groq/llama-3.3-70b-versatile": ModelConfig(
        provider=ModelProvider.GROQ,
        model_id="llama-3.3-70b-versatile",
        display_name="Llama 3.3 70B Versatile (Groq)",
        max_tokens=32768,
        cost_per_1k_tokens=0.00059,
    ),
    "groq/qwen-qwq-32b": ModelConfig(
        provider=ModelProvider.GROQ,
        model_id="qwen-qwq-32b",
        display_name="Qwen QwQ 32B (Groq)",
        max_tokens=32768,
        cost_per_1k_tokens=0.00029,
    ),
    "groq/deepseek-r1-distill-llama-70b": ModelConfig(
        provider=ModelProvider.GROQ,
        model_id="deepseek-r1-distill-llama-70b",
        display_name="DeepSeek R1 Distill Llama 70B (Groq)",
        max_tokens=32768,
        cost_per_1k_tokens=0.00075,
    ),
    
    # OpenAI models
    "openai/gpt-5": ModelConfig(
        provider=ModelProvider.OPENAI,
        model_id="gpt-5",
        display_name="GPT-4o (OpenAI)",
        max_tokens=16384,
        cost_per_1k_tokens=0.005,
    ),
    "openai/gpt-5-mini": ModelConfig(
        provider=ModelProvider.OPENAI,
        model_id="gpt-5-mini",
        display_name="GPT-4o Mini (OpenAI)",
        max_tokens=16384,
        cost_per_1k_tokens=0.00015,
    ),
    "openai/gpt-4-turbo": ModelConfig(
        provider=ModelProvider.OPENAI,
        model_id="gpt-4-turbo",
        display_name="GPT-4 Turbo (OpenAI)",
        max_tokens=4096,
        cost_per_1k_tokens=0.01,
    ),
    
    # Anthropic models
    "anthropic/claude-sonnet-4": ModelConfig(
        provider=ModelProvider.ANTHROPIC,
        model_id="claude-sonnet-4-20250514",
        display_name="Claude Sonnet 4 (Anthropic)",
        max_tokens=8192,
        cost_per_1k_tokens=0.003,
    ),
    "anthropic/claude-3.5-haiku": ModelConfig(
        provider=ModelProvider.ANTHROPIC,
        model_id="claude-3-5-haiku-latest",
        display_name="Claude 3.5 Haiku (Anthropic)",
        max_tokens=8192,
        cost_per_1k_tokens=0.001,
    ),
    "anthropic/claude-3-opus": ModelConfig(
        provider=ModelProvider.ANTHROPIC,
        model_id="claude-3-opus-20240229",
        display_name="Claude 3 Opus (Anthropic)",
        max_tokens=4096,
        cost_per_1k_tokens=0.015,
    ),
    
    # Google GenAI models
    "google/gemini-2.0-flash": ModelConfig(
        provider=ModelProvider.GOOGLE_GENAI,
        model_id="gemini-2.0-flash",
        display_name="Gemini 2.0 Flash (Google)",
        max_tokens=8192,
        cost_per_1k_tokens=0.0001,
    ),
    "google/gemini-2.5-pro": ModelConfig(
        provider=ModelProvider.GOOGLE_GENAI,
        model_id="gemini-2.5-pro",
        display_name="Gemini 2.5 Pro (Google)",
        max_tokens=8192,
        cost_per_1k_tokens=0.00125,
    ),
    
    # XAI Grok models
    "xai/grok-3": ModelConfig(
        provider=ModelProvider.XAI,
        model_id="grok-3",
        display_name="Grok 3 (xAI)",
        max_tokens=8192,
        cost_per_1k_tokens=0.003,
    ),
    "xai/grok-3-mini": ModelConfig(
        provider=ModelProvider.XAI,
        model_id="grok-3-mini",
        display_name="Grok 3 Mini (xAI)",
        max_tokens=8192,
        cost_per_1k_tokens=0.0003,
    ),
    
    # OpenRouter models (access to many OSS models)
    "openrouter/meta-llama/llama-3.1-8b-instruct": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_id="meta-llama/llama-3.1-8b-instruct",
        display_name="Llama 3.1 8B (OpenRouter)",
        max_tokens=8192,
        cost_per_1k_tokens=0.00006,
    ),
    "openrouter/meta-llama/llama-3.3-70b-instruct": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_id="meta-llama/llama-3.3-70b-instruct",
        display_name="Llama 3.3 70B (OpenRouter)",
        max_tokens=8192,
        cost_per_1k_tokens=0.00035,
    ),
    "openrouter/qwen/qwen-2.5-72b-instruct": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_id="qwen/qwen-2.5-72b-instruct",
        display_name="Qwen 2.5 72B (OpenRouter)",
        max_tokens=32768,
        cost_per_1k_tokens=0.0004,
    ),
    "openrouter/qwen/qwq-32b": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_id="qwen/qwq-32b",
        display_name="Qwen QwQ 32B (OpenRouter)",
        max_tokens=32768,
        cost_per_1k_tokens=0.0002,
    ),
    "openrouter/deepseek/deepseek-chat-v3": ModelConfig(
        provider=ModelProvider.OPENROUTER,
        model_id="deepseek/deepseek-chat-v3",
        display_name="DeepSeek Chat V3 (OpenRouter)",
        max_tokens=65536,
        cost_per_1k_tokens=0.00014,
    ),
    
    # Ollama local models
    "ollama/llama3.1:8b": ModelConfig(
        provider=ModelProvider.OLLAMA,
        model_id="llama3.1:8b",
        display_name="Llama 3.1 8B (Ollama)",
        max_tokens=8192,
        cost_per_1k_tokens=0.0,  # Free - local
    ),
    "ollama/llama3.1:70b": ModelConfig(
        provider=ModelProvider.OLLAMA,
        model_id="llama3.1:70b",
        display_name="Llama 3.1 70B (Ollama)",
        max_tokens=8192,
        cost_per_1k_tokens=0.0,
    ),
    "ollama/qwen2.5:32b": ModelConfig(
        provider=ModelProvider.OLLAMA,
        model_id="qwen2.5:32b",
        display_name="Qwen 2.5 32B (Ollama)",
        max_tokens=32768,
        cost_per_1k_tokens=0.0,
    ),
}


@dataclass
class BenchmarkModelConfig:
    """Complete model configuration for a benchmark run."""
    provider: ModelProvider
    model_id: str
    display_name: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    temperature: float = 0.0
    max_tokens: int = 4096
    
    @property
    def full_model_name(self) -> str:
        """Get the full model name for results tracking."""
        return f"{self.provider.value}/{self.model_id}"


def get_available_providers() -> list[ModelProvider]:
    """Get list of providers with available API keys/configs."""
    available: list[ModelProvider] = []
    
    for provider, config in PROVIDER_CONFIGS.items():
        if config.is_local:
            # Check if local service is available
            if provider == ModelProvider.OLLAMA:
                # Could check if Ollama is running, but for now just add it
                available.append(provider)
            elif provider == ModelProvider.LOCAL_AI:
                # Local AI requires models to be downloaded
                available.append(provider)
        else:
            # Check for API key
            api_key = os.environ.get(config.api_key_env, "")
            if api_key:
                available.append(provider)
    
    # Sort by priority
    available.sort(key=lambda p: PROVIDER_CONFIGS[p].priority, reverse=True)
    return available


def get_default_model_config() -> Optional[BenchmarkModelConfig]:
    """
    Get the default model configuration.
    
    Priority:
    1. BFCL_MODEL env var (if set to specific model)
    2. BFCL_PROVIDER env var (if set to specific provider)
    3. Groq with llama-3.1-8b-instant (if GROQ_API_KEY set)
    4. First available provider by priority
    """
    # Check for explicit model override
    explicit_model = os.environ.get("BFCL_MODEL", "")
    if explicit_model and explicit_model in SUPPORTED_MODELS:
        model_config = SUPPORTED_MODELS[explicit_model]
        provider_config = PROVIDER_CONFIGS[model_config.provider]
        api_key = os.environ.get(provider_config.api_key_env, "")
        
        if api_key or provider_config.is_local:
            return BenchmarkModelConfig(
                provider=model_config.provider,
                model_id=model_config.model_id,
                display_name=model_config.display_name,
                api_key=api_key if api_key else None,
                base_url=os.environ.get(
                    provider_config.base_url_env or "",
                    provider_config.default_base_url
                ),
                temperature=model_config.temperature,
                max_tokens=model_config.max_tokens,
            )
    
    # Check for explicit provider override
    explicit_provider = os.environ.get("BFCL_PROVIDER", "")
    if explicit_provider:
        try:
            provider = ModelProvider(explicit_provider.lower())
            if provider in get_available_providers():
                provider_config = PROVIDER_CONFIGS[provider]
                api_key = os.environ.get(provider_config.api_key_env, "")
                return BenchmarkModelConfig(
                    provider=provider,
                    model_id=provider_config.small_model,
                    display_name=f"{provider_config.small_model} ({provider.value})",
                    api_key=api_key if api_key else None,
                    base_url=os.environ.get(
                        provider_config.base_url_env or "",
                        provider_config.default_base_url
                    ),
                )
        except ValueError:
            logger.warning(f"Unknown provider: {explicit_provider}")
    
    # Use default: Groq with llama-3.1-8b-instant
    available = get_available_providers()
    if not available:
        logger.warning("No model providers available")
        return None
    
    # Prefer Groq as default
    if ModelProvider.GROQ in available:
        provider = ModelProvider.GROQ
    else:
        provider = available[0]
    
    provider_config = PROVIDER_CONFIGS[provider]
    api_key = os.environ.get(provider_config.api_key_env, "")
    
    return BenchmarkModelConfig(
        provider=provider,
        model_id=provider_config.small_model,
        display_name=f"{provider_config.small_model} ({provider.value})",
        api_key=api_key if api_key else None,
        base_url=os.environ.get(
            provider_config.base_url_env or "",
            provider_config.default_base_url
        ),
    )


def get_model_config(model_name: str) -> Optional[BenchmarkModelConfig]:
    """Get configuration for a specific model."""
    if model_name not in SUPPORTED_MODELS:
        logger.warning(f"Unknown model: {model_name}")
        return None
    
    model_config = SUPPORTED_MODELS[model_name]
    provider_config = PROVIDER_CONFIGS[model_config.provider]
    api_key = os.environ.get(provider_config.api_key_env, "")
    
    if not api_key and not provider_config.is_local:
        logger.warning(f"No API key for provider {model_config.provider.value}")
        return None
    
    return BenchmarkModelConfig(
        provider=model_config.provider,
        model_id=model_config.model_id,
        display_name=model_config.display_name,
        api_key=api_key if api_key else None,
        base_url=os.environ.get(
            provider_config.base_url_env or "",
            provider_config.default_base_url
        ),
        temperature=model_config.temperature,
        max_tokens=model_config.max_tokens,
    )


def list_available_models() -> list[str]:
    """List all available models based on configured API keys."""
    available_providers = set(get_available_providers())
    return [
        name for name, config in SUPPORTED_MODELS.items()
        if config.provider in available_providers
    ]


def get_model_display_info() -> str:
    """Get formatted display info about available models."""
    lines = ["Available Model Providers:", ""]
    
    for provider in get_available_providers():
        config = PROVIDER_CONFIGS[provider]
        lines.append(f"  ✓ {provider.value}")
        lines.append(f"    Small: {config.small_model}")
        lines.append(f"    Large: {config.large_model}")
        lines.append("")
    
    unavailable = set(ModelProvider) - set(get_available_providers())
    if unavailable:
        lines.append("Unavailable (set API key to enable):")
        for provider in unavailable:
            config = PROVIDER_CONFIGS[provider]
            if not config.is_local:
                lines.append(f"  ✗ {provider.value} ({config.api_key_env})")
    
    return "\n".join(lines)
