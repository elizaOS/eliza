from __future__ import annotations

import os

import pytest


@pytest.fixture
def mock_api_key() -> str:
    return "sk-test-mock-key-12345"


@pytest.fixture
def real_api_key() -> str | None:
    return os.environ.get("OPENROUTER_API_KEY")
