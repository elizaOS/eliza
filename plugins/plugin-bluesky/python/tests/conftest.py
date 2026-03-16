import pytest


@pytest.fixture
def mock_config() -> dict[str, str]:
    return {
        "handle": "test.bsky.social",
        "password": "test-password",
        "service": "https://bsky.social",
    }
