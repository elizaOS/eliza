from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

DEFAULT_FORBIDDEN_COMMANDS: tuple[str, ...] = (
    "rm -rf /",
    "rmdir",
    "chmod 777",
    "chown",
    "chgrp",
    "shutdown",
    "reboot",
    "halt",
    "poweroff",
    "kill -9",
    "killall",
    "pkill",
    "sudo rm -rf",
    "su",
    "passwd",
    "useradd",
    "userdel",
    "groupadd",
    "groupdel",
    "format",
    "fdisk",
    "mkfs",
    "dd if=/dev/zero",
    "shred",
    ":(){:|:&};:",
)


def validate_path(
    command_path: str,
    allowed_dir: str,
    current_dir: str,
) -> str | None:
    try:
        if os.path.isabs(command_path):
            resolved_path = os.path.normpath(command_path)
        else:
            resolved_path = os.path.normpath(os.path.join(current_dir, command_path))

        normalized_allowed = os.path.normpath(allowed_dir)

        if not resolved_path.startswith(normalized_allowed):
            logger.warning(
                f"Path validation failed: {resolved_path} is outside "
                f"allowed directory {normalized_allowed}"
            )
            return None

        return resolved_path
    except Exception as e:
        logger.error(f"Error validating path: {e}")
        return None


def is_safe_command(command: str) -> bool:
    path_traversal_patterns = [
        r"\.\./",
        r"\.\.\\",
        r"/\.\.",
        r"\\\.\.",
    ]

    dangerous_patterns = [
        r"\$\(",
        r"`[^']*`",
        r"\|\s*sudo",
        r";\s*sudo",
        r"&\s*&",
        r"\|\s*\|",
    ]

    for pattern in path_traversal_patterns:
        if re.search(pattern, command):
            logger.warning(f"Path traversal detected in command: {command}")
            return False

    for pattern in dangerous_patterns:
        if re.search(pattern, command):
            logger.warning(f"Dangerous pattern detected in command: {command}")
            return False

    pipe_count = len(re.findall(r"\|", command))
    if pipe_count > 1:
        logger.warning(f"Multiple pipes detected in command: {command}")
        return False

    return True


def extract_base_command(full_command: str) -> str:
    parts = full_command.strip().split()
    return parts[0] if parts else ""


def is_forbidden_command(
    command: str,
    forbidden_commands: list[str],
) -> bool:
    normalized_command = command.strip().lower()

    for forbidden in forbidden_commands:
        forbidden_lower = forbidden.lower()

        if normalized_command.startswith(forbidden_lower):
            return True

        if " " not in forbidden:
            base_command = extract_base_command(command)
            if base_command.lower() == forbidden_lower:
                return True

    return False
