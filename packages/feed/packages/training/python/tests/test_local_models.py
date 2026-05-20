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


def test_default_local_model_for_backend_uses_qwen35_defaults(monkeypatch) -> None:
    monkeypatch.delenv("BABYLON_LOCAL_MLX_MODEL", raising=False)
    monkeypatch.delenv("BABYLON_LOCAL_CUDA_MODEL", raising=False)
    monkeypatch.delenv("BABYLON_LOCAL_CPU_MODEL", raising=False)

    assert default_local_model_for_backend("mlx") == "mlx-community/Qwen3.5-4B-MLX-4bit"
    assert default_local_model_for_backend("cuda") == "Qwen/Qwen3.5-4B"
    assert default_local_model_for_backend("cpu") == "Qwen/Qwen3.5-4B"


def test_default_local_model_for_backend_honors_env_override(monkeypatch) -> None:
    monkeypatch.setenv("BABYLON_LOCAL_MLX_MODEL", "mlx-community/custom-qwen")

    assert default_local_model_for_backend("mlx") == "mlx-community/custom-qwen"
