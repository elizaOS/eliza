"""Pytest configuration and fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture
def tee_mode() -> str:
    """Get the TEE mode for testing."""
    return "LOCAL"


@pytest.fixture
def agent_id() -> str:
    """Get a test agent ID."""
    return "test-agent-id-12345"


@pytest.fixture
def secret_salt() -> str:
    """Get a test secret salt."""
    return "test-secret-salt"





