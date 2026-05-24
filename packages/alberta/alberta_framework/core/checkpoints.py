"""Checkpoint utilities for saving and loading learner state.

Provides ``save_checkpoint`` and ``load_checkpoint`` for persisting any
learner state (``LearnerState``, ``MLPLearnerState``, ``MultiHeadMLPState``,
``TDLearnerState``) to disk using ``orbax-checkpoint``.

The caller provides a *template* state (from ``learner.init()``) to
``load_checkpoint`` so the tree structure is known at load time.

For loading just metadata without a template (e.g. to read learner config
before constructing the template), use ``load_checkpoint_metadata``.

Examples
--------
```python
import jax.random as jr
from alberta_framework import MultiHeadMLPLearner, save_checkpoint, load_checkpoint

learner = MultiHeadMLPLearner(n_heads=5, hidden_sizes=(64, 64))
state = learner.init(feature_dim=20, key=jr.key(42))

# Save (creates a checkpoint directory at the given path)
save_checkpoint(state, "agent.ckpt", metadata={"epoch": 1})

# Load (template provides tree structure)
template = learner.init(feature_dim=20, key=jr.key(0))
loaded_state, meta = load_checkpoint(template, "agent.ckpt")
assert meta["epoch"] == 1

# Load metadata only (no template needed)
meta = load_checkpoint_metadata("agent.ckpt")
assert meta["epoch"] == 1
```
"""

from pathlib import Path
from typing import Any

import orbax.checkpoint as ocp

# Format version for future compatibility
_FORMAT_VERSION = 2

# Internal metadata key — stripped from user-facing metadata
_VERSION_KEY = "_format_version"


def save_checkpoint(
    state: Any,
    path: str | Path,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Save learner state to disk.

    Creates a checkpoint directory at ``path`` containing the serialized
    state PyTree and optional user metadata as JSON.

    Args:
        state: Any learner state (LearnerState, MLPLearnerState,
            MultiHeadMLPState, TDLearnerState)
        path: Path for the checkpoint directory.
        metadata: Optional user metadata dict to store alongside
            the checkpoint (e.g. epoch, learner config, etc.)
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    meta_to_save = {_VERSION_KEY: _FORMAT_VERSION}
    if metadata is not None:
        meta_to_save.update(metadata)

    with ocp.Checkpointer(ocp.CompositeCheckpointHandler()) as ckptr:
        ckptr.save(
            str(path),
            args=ocp.args.Composite(
                state=ocp.args.StandardSave(state),
                metadata=ocp.args.JsonSave(meta_to_save),
            ),
        )


def load_checkpoint(
    state_template: Any,
    path: str | Path,
) -> tuple[Any, dict[str, Any]]:
    """Load checkpoint into a state matching the template's tree structure.

    The template state (from ``learner.init()``) provides the PyTree
    structure for deserialization.

    Args:
        state_template: A state of the same type and structure as the
            saved state. Typically created via ``learner.init()`` with
            the same architecture.
        path: Path to the checkpoint directory.

    Returns:
        Tuple of ``(loaded_state, user_metadata)`` where ``user_metadata``
        is the dict passed to ``save_checkpoint``, or an empty dict if
        none was provided.

    Raises:
        FileNotFoundError: If checkpoint directory doesn't exist
        ValueError: If state structure doesn't match template
    """
    path = Path(path)

    if not path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {path}")

    try:
        with ocp.Checkpointer(ocp.CompositeCheckpointHandler()) as ckptr:
            loaded = ckptr.restore(
                str(path),
                args=ocp.args.Composite(
                    state=ocp.args.StandardRestore(state_template),
                    metadata=ocp.args.JsonRestore(),
                ),
            )
    except ValueError as e:
        raise ValueError(
            f"State structure mismatch. "
            f"Ensure the learner architecture matches the saved checkpoint. "
            f"Original error: {e}"
        ) from e

    user_metadata = dict(loaded.metadata)
    user_metadata.pop(_VERSION_KEY, None)
    return loaded.state, user_metadata


def load_checkpoint_metadata(path: str | Path) -> dict[str, Any]:
    """Load only the user metadata from a checkpoint, without a state template.

    This is useful when metadata contains configuration needed to construct
    the state template (e.g. learner_config in rlsecd).

    Args:
        path: Path to the checkpoint directory.

    Returns:
        The user metadata dict, or an empty dict if none was stored.

    Raises:
        FileNotFoundError: If checkpoint directory doesn't exist
    """
    path = Path(path)

    if not path.exists():
        raise FileNotFoundError(f"Checkpoint not found: {path}")

    with ocp.Checkpointer(ocp.CompositeCheckpointHandler()) as ckptr:
        loaded = ckptr.restore(
            str(path),
            args=ocp.args.Composite(
                metadata=ocp.args.JsonRestore(),
            ),
        )

    user_metadata = dict(loaded.metadata)
    user_metadata.pop(_VERSION_KEY, None)
    return user_metadata


def checkpoint_exists(path: str | Path) -> bool:
    """Check whether a checkpoint exists at the given path.

    Args:
        path: Path to check for a checkpoint directory.

    Returns:
        True if a checkpoint directory exists at the path.
    """
    path = Path(path)
    # Orbax checkpoints are directories containing a state/ subdirectory
    return path.is_dir() and (path / "state").is_dir()
