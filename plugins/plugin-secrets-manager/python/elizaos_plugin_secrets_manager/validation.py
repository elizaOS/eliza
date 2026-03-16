"""
Secret Validation module.

Provides validation strategies for common API keys and secret formats.
"""

import re
import logging
from typing import Optional, Dict, Callable, Awaitable
from dataclasses import dataclass


logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Result of secret validation."""
    is_valid: bool
    error: Optional[str] = None


# Type alias for validators
ValidationStrategy = Callable[[str, str], Awaitable[ValidationResult]]


# Registry for validation strategies
_validation_strategies: Dict[str, ValidationStrategy] = {}


def register_validator(name: str, validator: ValidationStrategy) -> None:
    """Register a validation strategy."""
    _validation_strategies[name] = validator


def get_validator(name: str) -> Optional[ValidationStrategy]:
    """Get a validation strategy by name."""
    return _validation_strategies.get(name)


async def validate_secret(
    key: str,
    value: str,
    method: Optional[str] = None,
) -> ValidationResult:
    """Validate a secret value."""
    if not method or method == "none":
        return ValidationResult(is_valid=True)
    
    # Try to get registered validator
    validator = get_validator(method)
    if validator:
        return await validator(key, value)
    
    # Fall back to built-in strategies
    if method in BUILT_IN_VALIDATORS:
        return await BUILT_IN_VALIDATORS[method](key, value)
    
    # Auto-detect based on key name
    if method == "auto":
        inferred = infer_validation_strategy(key)
        if inferred and inferred in BUILT_IN_VALIDATORS:
            return await BUILT_IN_VALIDATORS[inferred](key, value)
    
    # Unknown method - pass
    logger.warning(f"Unknown validation method: {method}")
    return ValidationResult(is_valid=True)


def infer_validation_strategy(key: str) -> Optional[str]:
    """Infer validation strategy from key name."""
    key_lower = key.lower()
    
    if "openai" in key_lower:
        return "openai"
    if "anthropic" in key_lower or "claude" in key_lower:
        return "anthropic"
    if "groq" in key_lower:
        return "groq"
    if "google" in key_lower or "gemini" in key_lower:
        return "google"
    if "mistral" in key_lower:
        return "mistral"
    if "cohere" in key_lower:
        return "cohere"
    if "url" in key_lower or "endpoint" in key_lower:
        return "url"
    if "discord" in key_lower:
        return "discord"
    if "telegram" in key_lower:
        return "telegram"
    if "github" in key_lower:
        return "github"
    
    return None


# ============================================================================
# Built-in Validation Strategies
# ============================================================================

async def validate_openai(key: str, value: str) -> ValidationResult:
    """Validate OpenAI API key format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # OpenAI keys start with sk- and are typically 51 chars
    if not value.startswith("sk-"):
        return ValidationResult(is_valid=False, error="OpenAI keys must start with 'sk-'")
    
    if len(value) < 20:
        return ValidationResult(is_valid=False, error="OpenAI key too short")
    
    # Check for valid characters
    if not re.match(r"^sk-[a-zA-Z0-9_-]+$", value):
        return ValidationResult(is_valid=False, error="Invalid characters in OpenAI key")
    
    return ValidationResult(is_valid=True)


async def validate_anthropic(key: str, value: str) -> ValidationResult:
    """Validate Anthropic API key format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # Anthropic keys start with sk-ant-
    if not value.startswith("sk-ant-"):
        return ValidationResult(is_valid=False, error="Anthropic keys must start with 'sk-ant-'")
    
    if len(value) < 20:
        return ValidationResult(is_valid=False, error="Anthropic key too short")
    
    return ValidationResult(is_valid=True)


async def validate_groq(key: str, value: str) -> ValidationResult:
    """Validate Groq API key format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # Groq keys start with gsk_
    if not value.startswith("gsk_"):
        return ValidationResult(is_valid=False, error="Groq keys must start with 'gsk_'")
    
    if len(value) < 20:
        return ValidationResult(is_valid=False, error="Groq key too short")
    
    return ValidationResult(is_valid=True)


async def validate_google(key: str, value: str) -> ValidationResult:
    """Validate Google/Gemini API key format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # Google API keys are typically 39 chars and alphanumeric
    if len(value) < 30:
        return ValidationResult(is_valid=False, error="Google API key too short")
    
    if not re.match(r"^[a-zA-Z0-9_-]+$", value):
        return ValidationResult(is_valid=False, error="Invalid characters in Google API key")
    
    return ValidationResult(is_valid=True)


async def validate_mistral(key: str, value: str) -> ValidationResult:
    """Validate Mistral API key format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    if len(value) < 20:
        return ValidationResult(is_valid=False, error="Mistral key too short")
    
    return ValidationResult(is_valid=True)


async def validate_cohere(key: str, value: str) -> ValidationResult:
    """Validate Cohere API key format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    if len(value) < 20:
        return ValidationResult(is_valid=False, error="Cohere key too short")
    
    # Cohere keys are typically alphanumeric
    if not re.match(r"^[a-zA-Z0-9_-]+$", value):
        return ValidationResult(is_valid=False, error="Invalid characters in Cohere key")
    
    return ValidationResult(is_valid=True)


async def validate_url(key: str, value: str) -> ValidationResult:
    """Validate URL format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # Basic URL regex
    url_pattern = r"^https?://[^\s/$.?#].[^\s]*$"
    if not re.match(url_pattern, value, re.IGNORECASE):
        return ValidationResult(is_valid=False, error="Invalid URL format")
    
    return ValidationResult(is_valid=True)


async def validate_discord(key: str, value: str) -> ValidationResult:
    """Validate Discord bot token format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # Discord tokens have a specific format with dots
    parts = value.split(".")
    if len(parts) != 3:
        return ValidationResult(is_valid=False, error="Discord token must have 3 parts separated by dots")
    
    if len(value) < 50:
        return ValidationResult(is_valid=False, error="Discord token too short")
    
    return ValidationResult(is_valid=True)


async def validate_telegram(key: str, value: str) -> ValidationResult:
    """Validate Telegram bot token format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # Telegram tokens have format: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
    pattern = r"^\d+:[A-Za-z0-9_-]+$"
    if not re.match(pattern, value):
        return ValidationResult(is_valid=False, error="Invalid Telegram token format")
    
    return ValidationResult(is_valid=True)


async def validate_github(key: str, value: str) -> ValidationResult:
    """Validate GitHub token format."""
    if not value:
        return ValidationResult(is_valid=False, error="Empty value")
    
    # GitHub tokens start with ghp_, gho_, ghu_, ghs_, or ghr_
    # Classic tokens start with ghp_, fine-grained with github_pat_
    valid_prefixes = ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_")
    if not value.startswith(valid_prefixes):
        return ValidationResult(
            is_valid=False,
            error="GitHub token must start with ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_"
        )
    
    if len(value) < 30:
        return ValidationResult(is_valid=False, error="GitHub token too short")
    
    return ValidationResult(is_valid=True)


async def validate_non_empty(key: str, value: str) -> ValidationResult:
    """Simple non-empty validation."""
    if not value or not value.strip():
        return ValidationResult(is_valid=False, error="Value cannot be empty")
    return ValidationResult(is_valid=True)


async def validate_min_length(min_len: int):
    """Create a minimum length validator."""
    async def validator(key: str, value: str) -> ValidationResult:
        if not value:
            return ValidationResult(is_valid=False, error="Empty value")
        if len(value) < min_len:
            return ValidationResult(
                is_valid=False,
                error=f"Value must be at least {min_len} characters"
            )
        return ValidationResult(is_valid=True)
    return validator


# Built-in validators registry
BUILT_IN_VALIDATORS: Dict[str, ValidationStrategy] = {
    "openai": validate_openai,
    "anthropic": validate_anthropic,
    "groq": validate_groq,
    "google": validate_google,
    "gemini": validate_google,  # Alias
    "mistral": validate_mistral,
    "cohere": validate_cohere,
    "url": validate_url,
    "discord": validate_discord,
    "telegram": validate_telegram,
    "github": validate_github,
    "non_empty": validate_non_empty,
}
