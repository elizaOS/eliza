"""Client factory and ``.env`` discovery for the benchmark.

Walks up from this module looking for the repo root (a ``.git`` directory),
loads ``.env`` from there, then constructs the requested client.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final, Literal

from dotenv import load_dotenv

from .anthropic import AnthropicClient
from .base import BaseClient
from .cerebras import CerebrasClient
from .hermes import HermesClient

Provider = Literal["cerebras", "anthropic", "hermes"]

_SUPPORTED_PROVIDERS: Final[tuple[str, ...]] = ("cerebras", "anthropic", "hermes")


def _find_repo_root() -> Path | None:
    """Walk up from this file looking for a ``.git`` directory."""
    here = Path(__file__).resolve()
    for candidate in (here, *here.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def _load_repo_dotenv() -> None:
    """Load ``.env`` from the repo root (idempotent; existing vars win)."""
    root = _find_repo_root()
    if root is None:
        return
    env_path = root / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=False)


def make_client(provider: str, model: str | None = None) -> BaseClient:
    """Construct a client for the requested provider.

    Loads the repo-root ``.env`` first so credentials are discoverable in dev.
    Existing process env vars take precedence over the file.
    """
    _load_repo_dotenv()
    if provider == "cerebras":
        return CerebrasClient(model=model)
    if provider == "anthropic":
        return AnthropicClient(model=model)
    if provider == "hermes":
        return HermesClient(model=model)
    raise ValueError(
        f"Unknown provider {provider!r}; supported: {', '.join(_SUPPORTED_PROVIDERS)}"
    )
