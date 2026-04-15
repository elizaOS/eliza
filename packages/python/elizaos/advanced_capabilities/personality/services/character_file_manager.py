"""CharacterFileManager -- safe character file modifications with backup and validation.

Handles backup, validation, and atomic updates of character definition files.
Operates in memory-only mode when no character file is detected on disk.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from google.protobuf.json_format import MessageToDict, ParseDict

from elizaos.types import MemoryType, Service
from elizaos.types.agent import CharacterSettings, StyleGuides

from ..types import PERSONALITY_SERVICE_TYPE

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Validation schema (mirrors the Zod schema from TypeScript)
# ---------------------------------------------------------------------------

_NAME_RE = re.compile(r"^[a-zA-Z0-9\s\-_]+$")
_FORBIDDEN_NAME_WORDS = {"admin", "system", "root"}
_INJECTION_PHRASES = {
    "ignore previous instructions",
    "disregard",
    "forget everything",
}


def _validate_name(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    name = value.strip()
    return (
        0 < len(name) < 100
        and bool(_NAME_RE.match(name))
        and not any(word in name.lower() for word in _FORBIDDEN_NAME_WORDS)
        and name == name.strip()
    )


def _validate_system(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    s = value
    return (
        10 < len(s) < 10_000
        and "<script>" not in s
        and "javascript:" not in s
        and "eval(" not in s
        and "Function(" not in s
        and not any(phrase in s.lower() for phrase in _INJECTION_PHRASES)
    )


def _validate_bio(value: Any) -> bool:
    if not isinstance(value, list):
        return False
    return all(
        isinstance(item, str)
        and 0 < len(item) < 500
        and "<script>" not in item
        and "javascript:" not in item
        for item in value
    )


def _validate_topics(value: Any) -> bool:
    if not isinstance(value, list):
        return False
    return all(isinstance(t, str) and 0 < len(t) < 100 and bool(_NAME_RE.match(t)) for t in value)


_FIELD_VALIDATORS: dict[str, Any] = {
    "name": _validate_name,
    "system": _validate_system,
    "bio": _validate_bio,
    "topics": _validate_topics,
}


class CharacterFileManager(Service):
    """Service for safely managing character file modifications."""

    name = "character_file_manager"
    service_type = PERSONALITY_SERVICE_TYPE

    @property
    def capability_description(self) -> str:
        return "Manages safe character file modifications with backup and validation"

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        self._runtime: IAgentRuntime | None = runtime
        self._character_file_path: str | None = None
        self._backup_dir: str = os.path.join(os.getcwd(), ".eliza", "character-backups")
        self._max_backups: int = 10

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> CharacterFileManager:
        manager = cls(runtime)
        await manager._initialize()
        return manager

    async def _initialize(self) -> None:
        Path(self._backup_dir).mkdir(parents=True, exist_ok=True)
        await self._detect_character_file()
        logger.debug(
            "CharacterFileManager initialized: file=%s, backup=%s",
            self._character_file_path,
            self._backup_dir,
        )

    async def _detect_character_file(self) -> None:
        if not self._runtime:
            return

        character = self._runtime.character
        char_name = character.name if hasattr(character, "name") else ""

        cwd = os.getcwd()
        possible_paths = [
            os.path.join(cwd, f"{char_name}.json"),
            os.path.join(cwd, "character.json"),
            os.path.join(cwd, "agent", f"{char_name}.json"),
            os.path.join(cwd, "agent", "character.json"),
            os.path.join(cwd, "characters", f"{char_name}.json"),
            os.path.join(cwd, "characters", "character.json"),
        ]

        for file_path in possible_paths:
            if os.path.exists(file_path):
                try:
                    with open(file_path, encoding="utf-8") as f:
                        content = json.load(f)
                    if content.get("name") == char_name:
                        self._character_file_path = file_path
                        logger.debug("Character file detected: %s", file_path)
                        return
                except Exception:
                    continue

        logger.debug("No character file on disk, operating in memory-only mode")

    async def create_backup(self) -> str | None:
        """Create a backup of the current character file."""
        if not self._character_file_path:
            logger.warning("No character file path available for backup")
            return None

        try:
            timestamp = time.strftime("%Y%m%dT%H%M%S")
            basename = os.path.splitext(os.path.basename(self._character_file_path))[0]
            backup_name = f"{basename}-{timestamp}.json"
            backup_path = os.path.join(self._backup_dir, backup_name)

            shutil.copy2(self._character_file_path, backup_path)
            await self._cleanup_old_backups()
            logger.info("Character backup created: %s", backup_path)
            return backup_path
        except Exception as e:
            logger.error("Failed to create character backup: %s", e)
            return None

    async def _cleanup_old_backups(self) -> None:
        try:
            files = []
            for f in os.listdir(self._backup_dir):
                if f.endswith(".json"):
                    fpath = os.path.join(self._backup_dir, f)
                    files.append((fpath, os.path.getmtime(fpath)))
            files.sort(key=lambda x: x[1], reverse=True)

            for fpath, _ in files[self._max_backups :]:
                os.unlink(fpath)

            removed = max(0, len(files) - self._max_backups)
            if removed:
                logger.info("Cleaned up %d old backups", removed)
        except Exception as e:
            logger.error("Error cleaning up old backups: %s", e)

    def validate_modification(self, modification: dict[str, Any]) -> dict[str, Any]:
        """Validate a character modification. Returns {valid, errors}."""
        errors: list[str] = []

        # Field validation
        for field_name, validator in _FIELD_VALIDATORS.items():
            if field_name in modification:
                if not validator(modification[field_name]):
                    errors.append(f"Invalid {field_name}: failed validation rules")

        # Safety checks
        bio = modification.get("bio")
        if isinstance(bio, list) and len(bio) > 20:
            errors.append("Too many bio elements - maximum 20 allowed")

        topics = modification.get("topics")
        if isinstance(topics, list) and len(topics) > 50:
            errors.append("Too many topics - maximum 50 allowed")

        return {"valid": len(errors) == 0, "errors": errors}

    async def apply_modification(self, modification: dict[str, Any]) -> dict[str, Any]:
        """Apply a validated modification to the character."""
        validation = self.validate_modification(modification)
        if not validation["valid"]:
            return {
                "success": False,
                "error": f"Validation failed: {', '.join(validation['errors'])}",
            }

        if not self._runtime:
            return {"success": False, "error": "Runtime not available"}

        try:
            await self.create_backup()

            character = self._runtime.character
            getattr(character, "name", None)

            # Apply modifications (additive merge, not replacement)
            if "name" in modification:
                old_name = getattr(character, "name", "")
                character.name = modification["name"]
                logger.info("Character name changed: %s -> %s", old_name, modification["name"])

            if "system" in modification:
                character.system = modification["system"]
                logger.info("System prompt modified")

            if "bio" in modification:
                current_bio = getattr(character, "bio", [])
                if isinstance(current_bio, str):
                    current_bio = [current_bio]
                elif not isinstance(current_bio, list):
                    current_bio = []

                new_elements = [
                    b
                    for b in modification["bio"]
                    if not any(
                        existing.lower() in b.lower() or b.lower() in existing.lower()
                        for existing in current_bio
                    )
                ]
                character.bio = current_bio + new_elements

            if "topics" in modification:
                current_topics = getattr(character, "topics", []) or []
                new_topics = [t for t in modification["topics"] if t not in current_topics]
                character.topics = current_topics + new_topics

            if "message_examples" in modification:
                current_examples = getattr(character, "message_examples", []) or []
                character.message_examples = current_examples + modification["message_examples"]

            if "style" in modification:
                style_update = modification["style"]
                if isinstance(style_update, dict):
                    current_style = MessageToDict(character.style, preserving_proto_field_name=True)
                    for key, value in style_update.items():
                        existing = current_style.get(key, [])
                        existing_list = existing if isinstance(existing, list) else []
                        incoming_list = value if isinstance(value, list) else [value]
                        current_style[key] = existing_list + incoming_list
                    character.style.CopyFrom(ParseDict(current_style, StyleGuides()))

            if "settings" in modification:
                settings_update = modification["settings"]
                if isinstance(settings_update, dict):
                    current_settings = MessageToDict(
                        character.settings, preserving_proto_field_name=True
                    )
                    current_settings.update(settings_update)
                    character.settings.CopyFrom(ParseDict(current_settings, CharacterSettings()))

            # Write to file if available
            if self._character_file_path:
                char_dict = {}
                for attr in (
                    "name",
                    "system",
                    "bio",
                    "topics",
                    "message_examples",
                    "style",
                    "settings",
                ):
                    val = getattr(character, attr, None)
                    if val is not None:
                        char_dict[attr] = val
                with open(self._character_file_path, "w", encoding="utf-8") as f:
                    json.dump(char_dict, f, indent=2, default=str)
                logger.info("Character file updated successfully")

            # Audit log (best-effort)
            try:
                await self._runtime.create_memory(
                    {
                        "entityId": str(self._runtime.agent_id),
                        "roomId": str(self._runtime.agent_id),
                        "content": {
                            "text": f"Character modification applied to file: {self._character_file_path or 'memory-only'}",
                            "source": "character_modification",
                        },
                        "metadata": {
                            "type": MemoryType.CUSTOM,
                            "service": PERSONALITY_SERVICE_TYPE,
                            "action": "character_modified",
                            "timestamp": int(time.time() * 1000),
                            "filePath": self._character_file_path,
                            "modificationType": "file_update",
                        },
                    },
                    "character_modifications",
                )
            except Exception as e:
                logger.warning("Character modification audit log failed: %s", e)

            return {"success": True}
        except Exception as e:
            logger.error("Failed to apply character modification: %s", e)
            return {"success": False, "error": f"Application failed: {e}"}

    async def get_modification_history(self, limit: int = 10) -> list[dict[str, Any]]:
        """Get recent modification history."""
        if not self._runtime:
            return []

        memories = await self._runtime.get_memories(
            {
                "entityId": str(self._runtime.agent_id),
                "count": limit,
                "tableName": "character_modifications",
            }
        )

        results: list[dict[str, Any]] = []
        for memory in memories:
            meta = memory.metadata if hasattr(memory, "metadata") else {}
            if isinstance(meta, dict):
                results.append(
                    {
                        "timestamp": meta.get("timestamp"),
                        "modification": meta.get("modification"),
                        "filePath": meta.get("filePath"),
                    }
                )
        return results

    async def get_available_backups(self) -> list[dict[str, Any]]:
        """Get list of available backups."""
        if not os.path.exists(self._backup_dir):
            return []

        backups: list[dict[str, Any]] = []
        for filename in os.listdir(self._backup_dir):
            if filename.endswith(".json"):
                fpath = os.path.join(self._backup_dir, filename)
                stat = os.stat(fpath)
                backups.append(
                    {
                        "path": fpath,
                        "timestamp": int(stat.st_mtime * 1000),
                        "size": stat.st_size,
                    }
                )
        return sorted(backups, key=lambda b: b["timestamp"], reverse=True)

    async def restore_from_backup(self, backup_path: str) -> dict[str, Any]:
        """Restore character from a backup file."""
        if not os.path.exists(backup_path):
            return {"success": False, "error": "Backup file not found"}

        try:
            with open(backup_path, encoding="utf-8") as f:
                backup_content = json.load(f)

            if not isinstance(backup_content.get("name"), str):
                return {"success": False, "error": "Invalid backup file format"}

            # Create backup of current state
            await self.create_backup()

            # Update runtime character
            if self._runtime:
                for key, value in backup_content.items():
                    setattr(self._runtime.character, key, value)

            # Update file
            if self._character_file_path:
                with open(self._character_file_path, "w", encoding="utf-8") as f:
                    json.dump(backup_content, f, indent=2, default=str)

            logger.info("Character restored from backup: %s", backup_path)
            return {"success": True}
        except Exception as e:
            logger.error("Failed to restore from backup: %s", e)
            return {"success": False, "error": f"Restoration failed: {e}"}

    async def stop(self) -> None:
        logger.info("CharacterFileManager stopped")
