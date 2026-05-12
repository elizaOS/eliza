"""Direct-CLI import parity for sibling benchmark adapters."""

from __future__ import annotations


def test_lifeops_can_bootstrap_sibling_adapter_sources() -> None:
    from eliza_lifeops_bench.agents.adapter_paths import (
        ensure_benchmark_adapters_importable,
    )

    ensure_benchmark_adapters_importable("eliza", "hermes", "openclaw")

    import eliza_adapter.lifeops_bench  # noqa: F401
    import hermes_adapter.lifeops_bench  # noqa: F401
    import openclaw_adapter.lifeops_bench  # noqa: F401
