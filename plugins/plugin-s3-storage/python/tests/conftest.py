"""Test configuration and fixtures."""

import pytest


@pytest.fixture
def s3_config() -> dict[str, str]:
    """Provide test S3 configuration."""
    return {
        "access_key_id": "test-access-key",
        "secret_access_key": "test-secret-key",
        "region": "us-east-1",
        "bucket": "test-bucket",
    }

