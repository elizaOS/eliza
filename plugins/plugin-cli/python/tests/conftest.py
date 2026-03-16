"""Shared test fixtures for plugin-cli tests."""

from __future__ import annotations

import pytest

from elizaos_plugin_cli.registry import CliRegistry
from elizaos_plugin_cli.types import CliArg, CliCommand


@pytest.fixture
def registry() -> CliRegistry:
    """Create a fresh, empty CliRegistry for each test."""
    return CliRegistry()


@pytest.fixture
def sample_command() -> CliCommand:
    """A sample command for testing."""
    return CliCommand(
        name="run",
        description="Run the agent",
        handler_name="handle_run",
        aliases=("start", "go"),
        args=(
            CliArg.required_arg("target", "Deployment target"),
            CliArg.optional_arg("port", "Listen port", "3000"),
        ),
        priority=10,
    )
