from __future__ import annotations

import pytest


@pytest.fixture
def tee_mode() -> str:
    return "LOCAL"


@pytest.fixture
def agent_id() -> str:
    return "test-agent-id-12345"


@pytest.fixture
def secret_salt() -> str:
    return "test-secret-salt"
