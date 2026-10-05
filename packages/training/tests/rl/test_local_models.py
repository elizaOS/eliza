from __future__ import annotations

from eliza_training.rl.local_models import default_local_model_for_backend


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
