"""Direct-CLI import parity for sibling benchmark adapters."""

from __future__ import annotations

import importlib
import importlib.util

import pytest

from eliza_lifeops_bench.agents.adapter_paths import (
    ensure_benchmark_adapter_importable,
)


def test_lifeops_can_bootstrap_sibling_adapter_sources() -> None:
    from eliza_lifeops_bench.agents.adapter_paths import (
        ensure_benchmark_adapters_importable,
    )

    ensure_benchmark_adapters_importable("eliza", "hermes", "openclaw")

    import eliza_adapter.lifeops_bench  # noqa: F401
    import hermes_adapter.lifeops_bench  # noqa: F401
    import openclaw_adapter.lifeops_bench  # noqa: F401


def test_adapter_internal_import_failure_is_not_treated_as_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_import = importlib.import_module
    monkeypatch.setattr(importlib.util, "find_spec", lambda _name: object())

    def fail_inside_adapter(name: str):
        if name == "eliza_adapter":
            raise ModuleNotFoundError(
                "missing dependency inside adapter",
                name="adapter_internal_dependency",
            )
        return real_import(name)

    monkeypatch.setattr(importlib, "import_module", fail_inside_adapter)

    with pytest.raises(
        ModuleNotFoundError,
        match="missing dependency inside adapter",
    ):
        ensure_benchmark_adapter_importable("eliza")
