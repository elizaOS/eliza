"""Secret Validation Module.

Provides validation strategies for different types of secrets
including API keys, URLs, and custom validation.

Ported from secrets/validation.ts.
"""

from __future__ import annotations

import logging
import os
import time
from urllib.parse import urlparse

from .types import CustomValidator, ValidationResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Built-in validation strategies
# ---------------------------------------------------------------------------


async def _validate_none(_key: str, _value: str) -> ValidationResult:
    """No validation -- always passes."""
    return ValidationResult(is_valid=True, validated_at=time.time())


async def _validate_openai_key(_key: str, value: str) -> ValidationResult:
    """OpenAI API key validation. Format: sk-... or sk-proj-..."""
    validated_at = time.time()

    if not value.startswith("sk-"):
        return ValidationResult(
            is_valid=False,
            error='OpenAI API key must start with "sk-"',
            validated_at=validated_at,
        )
    if len(value) < 20:
        return ValidationResult(
            is_valid=False,
            error="OpenAI API key is too short",
            validated_at=validated_at,
        )

    if os.environ.get("VALIDATE_API_KEYS") == "true":
        verified = await _verify_openai_key(value)
        if not verified.is_valid:
            return ValidationResult(
                is_valid=False,
                error=verified.error,
                validated_at=validated_at,
            )

    return ValidationResult(is_valid=True, validated_at=validated_at)


async def _validate_anthropic_key(_key: str, value: str) -> ValidationResult:
    """Anthropic API key validation. Format: sk-ant-..."""
    validated_at = time.time()

    if not value.startswith("sk-ant-"):
        return ValidationResult(
            is_valid=False,
            error='Anthropic API key must start with "sk-ant-"',
            validated_at=validated_at,
        )
    if len(value) < 30:
        return ValidationResult(
            is_valid=False,
            error="Anthropic API key is too short",
            validated_at=validated_at,
        )

    if os.environ.get("VALIDATE_API_KEYS") == "true":
        verified = await _verify_anthropic_key(value)
        if not verified.is_valid:
            return ValidationResult(
                is_valid=False,
                error=verified.error,
                validated_at=validated_at,
            )

    return ValidationResult(is_valid=True, validated_at=validated_at)


async def _validate_groq_key(_key: str, value: str) -> ValidationResult:
    """Groq API key validation. Format: gsk_..."""
    validated_at = time.time()

    if not value.startswith("gsk_"):
        return ValidationResult(
            is_valid=False,
            error='Groq API key must start with "gsk_"',
            validated_at=validated_at,
        )
    if len(value) < 20:
        return ValidationResult(
            is_valid=False,
            error="Groq API key is too short",
            validated_at=validated_at,
        )

    return ValidationResult(is_valid=True, validated_at=validated_at)


async def _validate_google_key(_key: str, value: str) -> ValidationResult:
    """Google API key validation. Format: AIza..."""
    validated_at = time.time()

    if not value.startswith("AIza"):
        return ValidationResult(
            is_valid=False,
            error='Google API key must start with "AIza"',
            validated_at=validated_at,
        )
    if len(value) < 30:
        return ValidationResult(
            is_valid=False,
            error="Google API key is too short",
            validated_at=validated_at,
        )

    return ValidationResult(is_valid=True, validated_at=validated_at)


async def _validate_mistral_key(_key: str, value: str) -> ValidationResult:
    """Mistral API key validation."""
    validated_at = time.time()
    if len(value) < 20:
        return ValidationResult(
            is_valid=False,
            error="Mistral API key is too short",
            validated_at=validated_at,
        )
    return ValidationResult(is_valid=True, validated_at=validated_at)


async def _validate_cohere_key(_key: str, value: str) -> ValidationResult:
    """Cohere API key validation."""
    validated_at = time.time()
    if len(value) < 20:
        return ValidationResult(
            is_valid=False,
            error="Cohere API key is too short",
            validated_at=validated_at,
        )
    return ValidationResult(is_valid=True, validated_at=validated_at)


async def _validate_url_valid(_key: str, value: str) -> ValidationResult:
    """URL format validation."""
    validated_at = time.time()
    try:
        result = urlparse(value)
        if not result.scheme or not result.netloc:
            raise ValueError("Missing scheme or netloc")
        return ValidationResult(is_valid=True, validated_at=validated_at)
    except Exception:
        return ValidationResult(
            is_valid=False,
            error="Invalid URL format",
            validated_at=validated_at,
        )


async def _validate_url_reachable(_key: str, value: str) -> ValidationResult:
    """URL reachability validation."""
    validated_at = time.time()

    try:
        result = urlparse(value)
        if not result.scheme or not result.netloc:
            raise ValueError("Missing scheme or netloc")
    except Exception:
        return ValidationResult(
            is_valid=False,
            error="Invalid URL format",
            validated_at=validated_at,
        )

    try:
        import aiohttp

        async with (
            aiohttp.ClientSession() as session,
            session.head(
                value,
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp,
        ):
            if resp.status >= 400:
                return ValidationResult(
                    is_valid=False,
                    error=f"URL returned status {resp.status}",
                    validated_at=validated_at,
                )
            return ValidationResult(is_valid=True, validated_at=validated_at)
    except ImportError:
        # aiohttp not available, fall back to format check only
        return ValidationResult(is_valid=True, validated_at=validated_at)
    except Exception as exc:
        return ValidationResult(
            is_valid=False,
            error=f"URL is not reachable: {exc}",
            validated_at=validated_at,
        )


async def _validate_custom(_key: str, _value: str) -> ValidationResult:
    """Custom validation placeholder."""
    return ValidationResult(
        is_valid=True,
        details="Custom validation not implemented",
        validated_at=time.time(),
    )


# ---------------------------------------------------------------------------
# Strategy registry
# ---------------------------------------------------------------------------

VALIDATION_STRATEGIES: dict[str, CustomValidator] = {
    "none": _validate_none,
    "api_key:openai": _validate_openai_key,
    "openai": _validate_openai_key,
    "api_key:anthropic": _validate_anthropic_key,
    "anthropic": _validate_anthropic_key,
    "api_key:groq": _validate_groq_key,
    "groq": _validate_groq_key,
    "api_key:google": _validate_google_key,
    "google": _validate_google_key,
    "api_key:mistral": _validate_mistral_key,
    "api_key:cohere": _validate_cohere_key,
    "url:valid": _validate_url_valid,
    "url:reachable": _validate_url_reachable,
    "custom": _validate_custom,
}

_custom_validators: dict[str, CustomValidator] = {}


def register_validator(name: str, validator: CustomValidator) -> None:
    """Register a custom validator."""
    _custom_validators[name] = validator
    logger.debug("[Validation] Registered custom validator: %s", name)


def unregister_validator(name: str) -> bool:
    """Unregister a custom validator."""
    return _custom_validators.pop(name, None) is not None


def get_validator(strategy: str) -> CustomValidator | None:
    """Get a validator by strategy name."""
    if strategy in VALIDATION_STRATEGIES:
        return VALIDATION_STRATEGIES[strategy]
    return _custom_validators.get(strategy)


async def validate_secret(
    key: str,
    value: str,
    strategy: str | None = None,
) -> ValidationResult:
    """Validate a secret value."""
    strategy_name = strategy or "none"
    validator = get_validator(strategy_name)

    if not validator:
        logger.warning("[Validation] Unknown validation strategy: %s", strategy_name)
        return ValidationResult(
            is_valid=True,
            details=f"Unknown validation strategy: {strategy_name}",
            validated_at=time.time(),
        )

    try:
        return await validator(key, value)
    except Exception as exc:
        error_message = str(exc)
        logger.error("[Validation] Error validating %s: %s", key, error_message)
        return ValidationResult(
            is_valid=False,
            error=error_message,
            validated_at=time.time(),
        )


def infer_validation_strategy(key: str) -> str:
    """Infer validation strategy from secret key name."""
    upper_key = key.upper()

    if "OPENAI" in upper_key and "KEY" in upper_key:
        return "api_key:openai"
    if "ANTHROPIC" in upper_key and "KEY" in upper_key:
        return "api_key:anthropic"
    if "GROQ" in upper_key and "KEY" in upper_key:
        return "api_key:groq"
    if "GOOGLE" in upper_key and "KEY" in upper_key:
        return "api_key:google"
    if "MISTRAL" in upper_key and "KEY" in upper_key:
        return "api_key:mistral"
    if "COHERE" in upper_key and "KEY" in upper_key:
        return "api_key:cohere"
    if "URL" in upper_key or "ENDPOINT" in upper_key:
        return "url:valid"
    return "none"


# ---------------------------------------------------------------------------
# API key verification helpers
# ---------------------------------------------------------------------------


async def _verify_openai_key(api_key: str) -> ValidationResult:
    """Verify OpenAI API key by making a test request."""
    try:
        import aiohttp

        async with (
            aiohttp.ClientSession() as session,
            session.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp,
        ):
            if resp.status == 401:
                return ValidationResult(
                    is_valid=False, error="Invalid API key", validated_at=time.time()
                )
            if resp.status == 429:
                return ValidationResult(is_valid=True, validated_at=time.time())
            if resp.status >= 400:
                return ValidationResult(
                    is_valid=False,
                    error=f"API returned status {resp.status}",
                    validated_at=time.time(),
                )
            return ValidationResult(is_valid=True, validated_at=time.time())
    except ImportError:
        return ValidationResult(is_valid=True, validated_at=time.time())
    except Exception as exc:
        return ValidationResult(
            is_valid=False, error=f"Failed to verify: {exc}", validated_at=time.time()
        )


async def _verify_anthropic_key(api_key: str) -> ValidationResult:
    """Verify Anthropic API key by making a test request."""
    try:
        import aiohttp

        async with (
            aiohttp.ClientSession() as session,
            session.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-3-haiku-20240307",
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "Hi"}],
                },
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp,
        ):
            if resp.status == 401:
                return ValidationResult(
                    is_valid=False, error="Invalid API key", validated_at=time.time()
                )
            if resp.status == 429:
                return ValidationResult(is_valid=True, validated_at=time.time())
            if resp.status == 400:
                body = await resp.json()
                if body.get("error", {}).get("type") == "invalid_request_error":
                    return ValidationResult(is_valid=True, validated_at=time.time())
            if resp.status >= 400 and resp.status != 400:
                return ValidationResult(
                    is_valid=False,
                    error=f"API returned status {resp.status}",
                    validated_at=time.time(),
                )
            return ValidationResult(is_valid=True, validated_at=time.time())
    except ImportError:
        return ValidationResult(is_valid=True, validated_at=time.time())
    except Exception as exc:
        return ValidationResult(
            is_valid=False, error=f"Failed to verify: {exc}", validated_at=time.time()
        )


# Alias for compatibility
validate = validate_secret
