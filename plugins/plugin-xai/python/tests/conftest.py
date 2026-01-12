"""Conftest for plugin-xai tests."""

import pytest

# Fixtures for testing can be added here


@pytest.fixture
def skip_without_elizaos() -> None:
    """Skip test if elizaos is not installed.

    Use this fixture for tests that require elizaos:
        def test_something(skip_without_elizaos):
            ...
    """
    pytest.importorskip("elizaos", reason="elizaos not installed")
