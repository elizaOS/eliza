"""Policy backend registry / dispatcher.

`get_policy_backend(name, **kwargs)` is the single entry point used by the
bridge (`policy.start` command handler) to instantiate a backend by name.
Unknown names raise `ValueError` — backends are explicit, never fuzzy-matched.
"""

from __future__ import annotations

from typing import Any

from eliza_robot.policy.base import PolicyBackend


def get_policy_backend(name: str, **kwargs: Any) -> PolicyBackend:
    """Instantiate a policy backend by name.

    Args:
        name: Backend identifier. Currently supported: ``"openpi"``.
        **kwargs: Forwarded to the backend constructor.

    Raises:
        ValueError: If ``name`` is not a registered backend.
    """
    if name == "openpi":
        # Local import keeps the registry cheap and avoids dragging openpi
        # adapter code into callers that don't use it.
        from eliza_robot.policy.openpi.client import OpenPIPolicyClient

        return OpenPIPolicyClient(**kwargs)

    raise ValueError(
        f"Unknown policy backend: {name!r}. Known backends: ['openpi']."
    )


__all__ = ["get_policy_backend"]
