from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

try:
    import numpy
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

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training.local_models import default_local_model_for_backend


def test_default_local_model_for_backend_uses_gemma4_defaults(monkeypatch) -> None:
    monkeypatch.delenv("FEED_LOCAL_MLX_MODEL", raising=False)
    monkeypatch.delenv("FEED_LOCAL_CUDA_MODEL", raising=False)
    monkeypatch.delenv("FEED_LOCAL_CPU_MODEL", raising=False)

    assert default_local_model_for_backend("mlx") == "mlx-community/gemma-4-e4b-it-4bit-MAD"
    assert default_local_model_for_backend("cuda") == "google/gemma-4-E2B"
    assert default_local_model_for_backend("cpu") == "google/gemma-4-E2B"


def test_default_local_model_for_backend_honors_env_override(monkeypatch) -> None:
    monkeypatch.setenv("FEED_LOCAL_MLX_MODEL", "mlx-community/custom-gemma")

    assert default_local_model_for_backend("mlx") == "mlx-community/custom-gemma"
