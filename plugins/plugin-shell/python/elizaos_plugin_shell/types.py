from __future__ import annotations

import os
from enum import Enum

from pydantic import BaseModel, Field, field_validator


class FileOperationType(str, Enum):
    CREATE = "create"
    WRITE = "write"
    READ = "read"
    DELETE = "delete"
    MKDIR = "mkdir"
    MOVE = "move"
    COPY = "copy"


class FileOperation(BaseModel):
    type: FileOperationType
    target: str
    secondary_target: str | None = None


class CommandResult(BaseModel):
    success: bool
    stdout: str
    stderr: str
    exit_code: int | None
    error: str | None = None
    executed_in: str


class CommandHistoryEntry(BaseModel):
    command: str
    stdout: str
    stderr: str
    exit_code: int | None
    timestamp: float
    working_directory: str
    file_operations: list[FileOperation] | None = None


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
    ":(){:|:&};:",
)


class ShellConfig(BaseModel):
    enabled: bool = False
    allowed_directory: str
    timeout: int = Field(default=30000, gt=0)
    forbidden_commands: list[str] = Field(default_factory=list)

    @field_validator("allowed_directory")
    @classmethod
    def validate_directory(cls, v: str) -> str:
        return os.path.abspath(os.path.expanduser(v))

    @classmethod
    def from_env(cls) -> ShellConfig:
        enabled = os.getenv("SHELL_ENABLED", "false").lower() == "true"
        allowed_directory = os.getenv("SHELL_ALLOWED_DIRECTORY", os.getcwd())
        timeout = int(os.getenv("SHELL_TIMEOUT", "30000"))

        custom_forbidden_str = os.getenv("SHELL_FORBIDDEN_COMMANDS", "")
        custom_forbidden = [cmd.strip() for cmd in custom_forbidden_str.split(",") if cmd.strip()]

        all_forbidden = list(set(list(DEFAULT_FORBIDDEN_COMMANDS) + custom_forbidden))

        return cls(
            enabled=enabled,
            allowed_directory=allowed_directory,
            timeout=timeout,
            forbidden_commands=all_forbidden,
        )
