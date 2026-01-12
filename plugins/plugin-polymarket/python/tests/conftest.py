"""Conftest for plugin-polymarket tests."""

import pytest

# Skip all tests in this module if py_clob_client is not installed
py_clob_client = pytest.importorskip("py_clob_client", reason="py_clob_client not installed")
