from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from google.protobuf.json_format import MessageToDict, ParseDict

from elizaos.types.agent import Character


class CharacterValidationError(Exception):
    def __init__(self, message: str, errors: list[str] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []


class CharacterLoadError(Exception):
    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


def parse_character(input_data: str | dict[str, Any] | Character) -> Character:
    if isinstance(input_data, Character):
        return input_data

    if isinstance(input_data, str):
        # Treat as file path
        return load_character_from_file(input_data)

    if isinstance(input_data, dict):
        return validate_and_create_character(input_data)

    raise CharacterValidationError("Invalid character input format")


def load_character_from_file(path: str) -> Character:
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
    try:
        character = Character()
        ParseDict(data, character)
        return character
    except Exception as e:
        error_message = str(e)
        raise CharacterValidationError(
            f"Character validation failed: {error_message}",
            errors=[error_message],
        ) from e


def validate_character_config(character: Character) -> dict[str, Any]:
    try:
        # Re-validate by converting to dict and back
        ParseDict(MessageToDict(character, preserving_proto_field_name=False), Character())
        return {
            "isValid": True,
            "errors": [],
        }
    except Exception as e:
        errors = [str(e)]
        return {
            "isValid": False,
            "errors": errors,
        }


def merge_character_defaults(char: dict[str, Any]) -> Character:
    defaults: dict[str, Any] = {
        "settings": {},
        "plugins": [],
        "bio": [],
    }

    merged = {**defaults, **char}
    if not merged.get("name"):
        merged["name"] = "Unnamed Character"

    character = Character()
    ParseDict(merged, character)
    return character


def build_character_plugins(env: dict[str, str | None] | None = None) -> list[str]:
    if env is None:
        env = dict(os.environ)

    def get_env(key: str) -> str | None:
        value = env.get(key)
        if value:
            return value.strip() if isinstance(value, str) else value
        return None

    plugins: list[str] = ["@elizaos/plugin-sql"]
    if get_env("ANTHROPIC_API_KEY"):
        plugins.append("@elizaos/plugin-anthropic")
    if get_env("OPENROUTER_API_KEY"):
        plugins.append("@elizaos/plugin-openrouter")

    # Embedding-capable plugins
    if get_env("OPENAI_API_KEY"):
        plugins.append("@elizaos/plugin-openai")
    if get_env("GOOGLE_GENERATIVE_AI_API_KEY"):
        plugins.append("@elizaos/plugin-google-genai")
    if get_env("DISCORD_API_TOKEN"):
        plugins.append("@elizaos/plugin-discord")
    if all(
        get_env(key)
        for key in [
            "X_API_KEY",
            "X_API_SECRET",
            "X_ACCESS_TOKEN",
            "X_ACCESS_TOKEN_SECRET",
        ]
    ):
        plugins.append("@elizaos/plugin-x")
    if get_env("TELEGRAM_BOT_TOKEN"):
        plugins.append("@elizaos/plugin-telegram")
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
