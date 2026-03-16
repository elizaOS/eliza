"""Pytest configuration and fixtures for the Scratchpad plugin tests."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import pytest

from elizaos_plugin_scratchpad.config import ScratchpadConfig
from elizaos_plugin_scratchpad.service import ScratchpadService


@pytest.fixture
def tmp_scratchpad_dir(tmp_path: Path) -> Path:
    """Create a temporary directory for scratchpad files."""
    scratchpad_dir = tmp_path / "scratchpad"
    scratchpad_dir.mkdir()
    return scratchpad_dir


@pytest.fixture
def config(tmp_scratchpad_dir: Path) -> ScratchpadConfig:
    """Create a test configuration with a temporary base path."""
    return ScratchpadConfig(
        base_path=str(tmp_scratchpad_dir),
        max_file_size=1024 * 1024,
        allowed_extensions=[".md", ".txt"],
    )


@pytest.fixture
def service(config: ScratchpadConfig) -> ScratchpadService:
    """Create a ScratchpadService instance for testing."""
    return ScratchpadService(runtime=None, config=config)
