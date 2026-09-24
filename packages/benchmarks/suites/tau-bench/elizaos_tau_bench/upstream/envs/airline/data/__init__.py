# Copyright Sierra

from typing import Any

from elizaos_tau_bench.data_assets import load_domain_data


def load_data() -> dict[str, Any]:
    # Same shadowing fix as retail: this ``data`` package wins over the sibling
    # ``data.py`` module on import, and this directory does not vendor the
    # airline JSON assets, so the upstream original raised FileNotFoundError.
    # Delegate to the shared loader (compact fixtures / official download).
    return load_domain_data("airline")
