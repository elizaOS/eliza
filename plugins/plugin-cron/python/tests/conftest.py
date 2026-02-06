from __future__ import annotations

import pytest

from elizaos_plugin_cron.service import CronService
from elizaos_plugin_cron.types import CronConfig


@pytest.fixture
def service() -> CronService:
    """A CronService with default config."""
    return CronService()


@pytest.fixture
def limited_service() -> CronService:
    """A CronService with max_jobs=2 for capacity testing."""
    return CronService(config=CronConfig(max_jobs=2))


@pytest.fixture
def disabled_service() -> CronService:
    """A disabled CronService."""
    return CronService(config=CronConfig(enabled=False))
