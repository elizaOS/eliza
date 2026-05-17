# Copyright Sierra

from typing import Any

from elizaos_tau_bench.data_assets import load_domain_data


def load_data() -> dict[str, Any]:
    return load_domain_data("retail")
