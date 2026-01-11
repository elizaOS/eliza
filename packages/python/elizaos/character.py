"""
Character utilities for elizaOS.

This module provides utilities for parsing and validating character configurations.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from elizaos.types.agent import Character


class CharacterValidationError(Exception):
    """Exception raised when character validation fails."""

    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []


class CharacterLoadError(Exception):
    """Exception raised when character loading fails."""

    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


def parse_character(input_data: str | dict[str, Any] | Character) -> Character:
    """
    Parse character input from various formats (string path, object, or Character).

    Args:
        input_data: Character data in various formats

    Returns:
        Parsed Character object

    Raises:
        CharacterValidationError: If validation fails
        CharacterLoadError: If loading from file fails
    """
    if isinstance(input_data, Character):
        return input_data

    if isinstance(input_data, str):
        # Treat as file path
        return load_character_from_file(input_data)

    if isinstance(input_data, dict):
        return validate_and_create_character(input_data)

    raise CharacterValidationError("Invalid character input format")


def load_character_from_file(path: str) -> Character:
    """
    Load a character configuration from a JSON file.

    Args:
        path: Path to the character JSON file

    Returns:
        Parsed Character object

    Raises:
        CharacterLoadError: If loading fails
    """
    try:
        file_path = Path(path)
        if not file_path.exists():
            raise CharacterLoadError(f"Character file not found: {path}")

        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)

        return validate_and_create_character(data)
    except json.JSONDecodeError as e:
        raise CharacterLoadError(f"Invalid JSON in character file: {path}", cause=e) from e
    except CharacterValidationError:
        raise
    except Exception as e:
        raise CharacterLoadError(f"Failed to load character from {path}: {e}", cause=e) from e


def validate_and_create_character(data: dict[str, Any]) -> Character:
    """
    Validate character data and create a Character instance.

    Args:
        data: Character data dictionary

    Returns:
        Validated Character object

    Raises:
        CharacterValidationError: If validation fails
    """
    try:
        return Character(**data)
    except ValidationError as e:
        errors = [f"{err['loc']}: {err['msg']}" for err in e.errors()]
        error_message = "; ".join(errors)
        raise CharacterValidationError(
            f"Character validation failed: {error_message}",
            errors=errors,
        ) from e


def validate_character_config(character: Character) -> dict[str, Any]:
    """
    Validate a character configuration.

    Args:
        character: Character to validate

    Returns:
        Validation result with isValid and errors
    """
    try:
        # Re-validate by converting to dict and back
        Character(**character.model_dump())
        return {
            "isValid": True,
            "errors": [],
        }
    except ValidationError as e:
        errors = [f"{err['loc']}: {err['msg']}" for err in e.errors()]
        return {
            "isValid": False,
            "errors": errors,
        }


def merge_character_defaults(char: dict[str, Any]) -> Character:
    """
    Merge character with default values.

    Args:
        char: Partial character configuration

    Returns:
        Complete character with defaults
    """
    defaults: dict[str, Any] = {
        "settings": {},
        "plugins": [],
        "bio": [],
    }

    merged = {**defaults, **char}
    if not merged.get("name"):
        merged["name"] = "Unnamed Character"

    return Character(**merged)


def build_character_plugins(env: dict[str, str | None] | None = None) -> list[str]:
    """
    Build ordered plugin list based on available environment variables.

    Plugin loading order:
    1. Core plugins (@elizaos/plugin-sql)
    2. Text-only LLM plugins (no embedding support)
    3. Embedding-capable LLM plugins
    4. Platform plugins (Discord, X, Telegram)
    5. Bootstrap plugin (unless IGNORE_BOOTSTRAP is set)
    6. Ollama fallback (only if no other LLM providers configured)

    Args:
        env: Environment dictionary (defaults to os.environ)

    Returns:
        Ordered list of plugin names
    """
    if env is None:
        env = dict(os.environ)

    def get_env(key: str) -> str | None:
        value = env.get(key)
        if value:
            return value.strip() if isinstance(value, str) else value
        return None

    plugins: list[str] = [
        # Core plugins first
        "@elizaos/plugin-sql",
    ]

    # Text-only plugins (no embedding support)
    if get_env("ANTHROPIC_API_KEY"):
        plugins.append("@elizaos/plugin-anthropic")
    if get_env("OPENROUTER_API_KEY"):
        plugins.append("@elizaos/plugin-openrouter")

    # Embedding-capable plugins
    if get_env("OPENAI_API_KEY"):
        plugins.append("@elizaos/plugin-openai")
    if get_env("GOOGLE_GENERATIVE_AI_API_KEY"):
        plugins.append("@elizaos/plugin-google-genai")

    # Platform plugins
    if get_env("DISCORD_API_TOKEN"):
        plugins.append("@elizaos/plugin-discord")
    if all(
        get_env(key)
        for key in [
            "TWITTER_API_KEY",
            "TWITTER_API_SECRET_KEY",
            "TWITTER_ACCESS_TOKEN",
            "TWITTER_ACCESS_TOKEN_SECRET",
        ]
    ):
        plugins.append("@elizaos/plugin-x")
    if get_env("TELEGRAM_BOT_TOKEN"):
        plugins.append("@elizaos/plugin-telegram")

    # Bootstrap plugin is now part of @elizaos/core and loaded automatically
    # No need to explicitly add it to the plugins list

    # Ollama fallback (only if no other LLM providers configured)
    has_llm_provider = any(
        get_env(key)
        for key in [
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_GENERATIVE_AI_API_KEY",
        ]
    )
    if not has_llm_provider:
        plugins.append("@elizaos/plugin-ollama")

    return plugins
