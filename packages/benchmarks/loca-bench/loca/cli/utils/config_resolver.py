# Copyright 2025 LOCA-bench Contributors. All Rights Reserved.
#
# Licensed under the MIT License.

"""Config path resolution utilities for LOCA-bench CLI."""

from enum import Enum
from pathlib import Path
from typing import List

# Project root is three levels up from this file
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent.resolve()


class Strategy(str, Enum):
    """Available context management strategies."""

    REACT = "react"
    PTC = "ptc"
    MEMORY_TOOL = "memory_tool"


def resolve_config_path(config_file: str) -> Path:
    """Resolve and validate a config file path.

    Args:
        config_file: Config file path (absolute or relative to cwd).

    Returns:
        Resolved absolute path to the config file.

    Raises:
        FileNotFoundError: If config file doesn't exist.
    """
    config_path = Path(config_file)

    if not config_path.is_absolute():
        config_path = Path.cwd() / config_path

    config_path = config_path.resolve()

    if not config_path.is_file():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    return config_path


def list_all_strategies() -> List[Strategy]:
    """List all available strategies.

    Returns:
        List of available strategies.
    """
    return list(Strategy)
