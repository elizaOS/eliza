from __future__ import annotations

import os
from typing import Literal

LocalTrainingBackend = Literal["mlx", "cuda", "cpu"]

DEFAULT_LOCAL_MODELS: dict[LocalTrainingBackend, str] = {
    "mlx": "mlx-community/Qwen3.5-4B-MLX-4bit",
    "cuda": "Qwen/Qwen3.5-4B",
    "cpu": "Qwen/Qwen3.5-4B",
}

DEFAULT_LOCAL_MODEL_ENV_VARS: dict[LocalTrainingBackend, str] = {
    "mlx": "FEED_LOCAL_MLX_MODEL",
    "cuda": "FEED_LOCAL_CUDA_MODEL",
    "cpu": "FEED_LOCAL_CPU_MODEL",
}


def default_local_model_for_backend(backend: LocalTrainingBackend) -> str:
    env_var = DEFAULT_LOCAL_MODEL_ENV_VARS[backend]
    configured = os.getenv(env_var)
    if configured and configured.strip():
        return configured.strip()
    return DEFAULT_LOCAL_MODELS[backend]
