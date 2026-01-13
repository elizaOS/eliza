"""Pytest configuration and fixtures."""

import os

import pytest


@pytest.fixture
def api_key() -> str:
    """Fixture to provide API key for integration tests.

    This fixture is used by integration tests marked with @pytest.mark.integration.
    If no API key is available, the test will fail (integration tests should only
    be run when API keys are explicitly provided).
    """
    key = (
        os.environ.get("AI_GATEWAY_API_KEY")
        or os.environ.get("AIGATEWAY_API_KEY")
        or os.environ.get("VERCEL_OIDC_TOKEN")
    )
    if not key:
        pytest.fail(
            "API key not available. Integration tests require AI_GATEWAY_API_KEY, "
            "AIGATEWAY_API_KEY, or VERCEL_OIDC_TOKEN to be set."
        )
    return key
