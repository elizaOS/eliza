"""Pytest configuration and fixtures for Alberta Framework tests."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import jax.numpy as jnp
import jax.random as jr
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
for import_path in (PROJECT_ROOT,):
    if str(import_path) not in sys.path:
        sys.path.insert(0, str(import_path))


def load_script(path: Path, name: str) -> ModuleType:
    """Load a Python script by filesystem path (works with paths containing spaces).

    Used by tests that exercise example scripts under
    ``examples/The Alberta Plan/`` whose directory name cannot be imported
    with the normal ``import`` statement.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.fixture
def rng_key():
    """Provide a deterministic JAX random key."""
    return jr.key(42)


@pytest.fixture
def feature_dim():
    """Default feature dimension for tests."""
    return 10


@pytest.fixture
def sample_observation(feature_dim, rng_key):
    """Generate a sample observation vector."""
    return jr.normal(rng_key, (feature_dim,), dtype=jnp.float32)


@pytest.fixture
def sample_target():
    """Generate a sample target value."""
    return jnp.array([1.5], dtype=jnp.float32)
