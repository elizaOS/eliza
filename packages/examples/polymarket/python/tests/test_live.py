from __future__ import annotations

import os
import importlib.util

import pytest


@pytest.mark.integration
def test_live_markets_fetch_gated() -> None:
    if os.getenv("POLYMARKET_LIVE_TESTS") != "1":
        return
    if importlib.util.find_spec("py_clob_client") is None:
        pytest.skip("py-clob-client is not installed in this environment")

    key = "0x" + "11" * 32
    os.environ["EVM_PRIVATE_KEY"] = key
    os.environ["POLYMARKET_PRIVATE_KEY"] = key
    os.environ["CLOB_API_URL"] = "https://clob.polymarket.com"

    from elizaos_plugin_polymarket.providers.clob import ClobClientProvider

    client = ClobClientProvider().get_client()
    resp = getattr(client, "get_markets")()
    if isinstance(resp, dict):
        data = resp.get("data")
    else:
        data = getattr(resp, "data", None)
    assert isinstance(data, list)
    assert len(data) > 0
    first = data[0]
    if isinstance(first, dict):
        assert isinstance(first.get("condition_id"), str)
        assert isinstance(first.get("active"), bool)
    else:
        assert hasattr(first, "condition_id")
        assert hasattr(first, "active")

