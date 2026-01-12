import os

import pytest


@pytest.fixture
def api_key() -> str:
    key = (
        os.environ.get("AI_GATEWAY_API_KEY")
        or os.environ.get("AIGATEWAY_API_KEY")
        or os.environ.get("VERCEL_OIDC_TOKEN")
    )
    if not key:
        pytest.skip("API key not available")
    return key

