"""
Path and command validation utilities for the shell plugin.
"""

from __future__ import annotations

import logging
import os
import re

logger = logging.getLogger(__name__)

# Default forbidden commands
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
    ":(){:|:&};:",  # Fork bomb
)


def validate_path(
    command_path: str,
    allowed_dir: str,
    current_dir: str,
) -> str | None:
    """
    Normalize a path and ensure it's within the allowed directory.

    Args:
        command_path: The path from the command
        allowed_dir: The allowed directory
        current_dir: The current working directory

    Returns:
        The normalized absolute path or None if invalid
    """
    try:
        # Resolve the path relative to current directory
        if os.path.isabs(command_path):
            resolved_path = os.path.normpath(command_path)
        else:
            resolved_path = os.path.normpath(os.path.join(current_dir, command_path))

        normalized_allowed = os.path.normpath(allowed_dir)

        # Check if the resolved path is within the allowed directory
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
    """
    Check if a command contains path traversal attempts or dangerous patterns.

    Args:
        command: The command to check

    Returns:
        True if the command appears safe, False if it contains dangerous patterns
    """
    # Check for path traversal patterns
    path_traversal_patterns = [
        r"\.\./",  # ../
        r"\.\.\\",  # ..\
        r"/\.\.",  # /..
        r"\\\.\.",  # \..
    ]

    # Check for dangerous command patterns
    dangerous_patterns = [
        r"\$\(",  # Command substitution $(
        r"`[^']*`",  # Command substitution ` (but allow in quotes)
        r"\|\s*sudo",  # Pipe to sudo
        r";\s*sudo",  # Chain with sudo
        r"&\s*&",  # && chaining
        r"\|\s*\|",  # || chaining
    ]

    # Check for path traversal
    for pattern in path_traversal_patterns:
        if re.search(pattern, command):
            logger.warning(f"Path traversal detected in command: {command}")
            return False

    # Check for dangerous patterns
    for pattern in dangerous_patterns:
        if re.search(pattern, command):
            logger.warning(f"Dangerous pattern detected in command: {command}")
            return False

    # Allow single pipes and redirects for file operations
    # but block multiple pipes
    pipe_count = len(re.findall(r"\|", command))
    if pipe_count > 1:
        logger.warning(f"Multiple pipes detected in command: {command}")
        return False

    return True


def extract_base_command(full_command: str) -> str:
    """
    Extract the base command from a full command string.

    Args:
        full_command: The full command string

    Returns:
        The base command
    """
    parts = full_command.strip().split()
    return parts[0] if parts else ""


def is_forbidden_command(
    command: str,
    forbidden_commands: list[str],
) -> bool:
    """
    Check if a command is in the forbidden list.

    Args:
        command: The command to check
        forbidden_commands: List of forbidden commands/patterns

    Returns:
        True if the command is forbidden
    """
    normalized_command = command.strip().lower()

    for forbidden in forbidden_commands:
        forbidden_lower = forbidden.lower()

        # Check if the command starts with the forbidden pattern
        if normalized_command.startswith(forbidden_lower):
            return True

        # Check if it's the exact base command for single-word forbidden commands
        if " " not in forbidden:
            base_command = extract_base_command(command)
            if base_command.lower() == forbidden_lower:
                return True

    return False





