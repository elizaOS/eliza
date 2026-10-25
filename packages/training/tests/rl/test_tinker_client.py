from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

try:
    import numpy  # noqa: F401
except ImportError:
    fake_numpy = ModuleType("numpy")
    fake_numpy.ndarray = object
    fake_numpy.float64 = float
    fake_numpy.int64 = int
    fake_numpy.bool_ = bool
    fake_numpy.number = (int, float)
    fake_numpy.object_ = object
    fake_numpy.array = lambda *args, **kwargs: list(args)
    fake_numpy.mean = lambda *_args, **_kwargs: 0.0
    fake_numpy.zeros = lambda *_args, **_kwargs: []
    fake_numpy.ones = lambda *_args, **_kwargs: []
    fake_numpy.random = SimpleNamespace(default_rng=lambda seed=None: SimpleNamespace())
    sys.modules["numpy"] = fake_numpy


def load_tinker_client_module():
    script_path = (
        Path(__file__).resolve().parents[2]
        / "scripts"
        / "rl"
        / "tinker"
        / "tinker_client.py"
    )
    spec = importlib.util.spec_from_file_location("tinker_client_under_test", script_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["tinker_client_under_test"] = module
    spec.loader.exec_module(module)
    return module


tinker_client = load_tinker_client_module()


def test_resolve_tinker_base_model_accepts_eliza_tier_alias() -> None:
    assert (
        tinker_client.resolve_tinker_base_model(
            "elizaos/eliza-1-4b",
            ["google/gemma-4-E2B", "google/gemma-4-E4B"],
        )
        == "google/gemma-4-E4B"
    )


def test_resolve_tinker_base_model_accepts_single_dated_gemma_match() -> None:
    assert (
        tinker_client.resolve_tinker_base_model(
            "google/gemma-4-E4B",
            ["google/gemma-4-E4B-20260618"],
        )
        == "google/gemma-4-E4B-20260618"
    )


def test_resolve_tinker_base_model_suggests_gemma_before_other_models() -> None:
    try:
        tinker_client.resolve_tinker_base_model(
            "missing/model",
            [
                "other/vendor-model",
                "google/gemma-4-E2B",
                "google/gemma-4-E4B",
            ],
        )
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("Expected unsupported model to raise RuntimeError")

    assert "google/gemma-4-E2B" in message
    assert "google/gemma-4-E4B" in message
    assert "other/vendor-model" not in message
