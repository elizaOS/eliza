from __future__ import annotations

import pytest

from elizaos_plugin_auto_trader.service import TradingService
from elizaos_plugin_auto_trader.types import TradingConfig


@pytest.fixture
def service() -> TradingService:
    return TradingService(TradingConfig())


@pytest.fixture
def disabled_service() -> TradingService:
    return TradingService(TradingConfig(enabled=False))
