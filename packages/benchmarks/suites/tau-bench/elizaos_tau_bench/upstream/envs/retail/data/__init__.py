# Copyright Sierra

from typing import Any

from elizaos_tau_bench.data_assets import load_domain_data


def load_data() -> dict[str, Any]:
    # This ``data`` PACKAGE shadows the sibling ``data.py`` MODULE (on import a
    # package wins over a same-named module), so ``from ...retail.data import
    # load_data`` resolves HERE — not to ``data.py``. The upstream original read
    # ``orders.json`` / ``products.json`` / ``users.json`` from this directory,
    # which only vendors ``products.json``, so every retail run died in env_init
    # with FileNotFoundError on ``orders.json``. Delegate to the shared loader
    # (compact fixtures for smoke, official upstream download otherwise) exactly
    # like ``data.py``.
    return load_domain_data("retail")
