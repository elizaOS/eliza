from __future__ import annotations

import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[2] / "deploy" / "runpod" / "setup.py"


def load_module():
    spec = importlib.util.spec_from_file_location("runpod_setup", MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_resolve_profile_uses_single_gpu_defaults():
    module = load_module()

    assert module.resolve_profile("a100", 1) == "a100"
    assert module.resolve_profile("h100", 1) == "h100"
    assert module.resolve_profile("h200", 1) == "h200"


def test_resolve_profile_uses_multi_gpu_matrix():
    module = load_module()

    assert module.resolve_profile("a100", 2) == "a100-2gpu"
    assert module.resolve_profile("h100", 2) == "h100-2gpu"
    assert module.resolve_profile("h200", 2) == "h200-2gpu"
    assert module.resolve_profile("h100", 4) == "h100-4gpu"


def test_default_storage_sizes_scale_with_gpu_class_and_count():
    module = load_module()

    assert module.default_storage_sizes("4090", 1) == (100, 50)
    assert module.default_storage_sizes("a100", 2) == (200, 150)
    assert module.default_storage_sizes("h100", 1) == (200, 150)
    assert module.default_storage_sizes("h200", 2) == (250, 150)
