"""Task ID -> Grader dynamic loading from tasks/<id>/grader.py."""

from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

from .base import AbstractGrader


def get_grader(
    task_id: str,
    tasks_dir: str | Path = "tasks",
    task_dir: str | Path | None = None,
) -> AbstractGrader:
    """Dynamically load and instantiate a grader from tasks/<task_id>/grader.py.

    If ``task_dir`` is given, try loading from that directory first (handles
    cases where the directory name differs from the task_id in task.yaml).
    """
    grader_path = Path(tasks_dir) / task_id / "grader.py"

    # Fallback: use the actual task directory when task_id doesn't match dir name
    if not grader_path.exists() and task_dir is not None:
        alt_path = Path(task_dir) / "grader.py"
        if alt_path.exists():
            grader_path = alt_path

    if not grader_path.exists():
        raise FileNotFoundError(
            f"No grader found at {grader_path} for task_id={task_id!r}"
        )

    module_name = f"task_grader_{task_id}"
    spec = importlib.util.spec_from_file_location(module_name, grader_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load grader module from {grader_path}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # Find the AbstractGrader subclass in the module
    for _name, obj in inspect.getmembers(module, inspect.isclass):
        if obj.__module__ != module.__name__:
            continue
        if issubclass(obj, AbstractGrader) and obj is not AbstractGrader:
            return obj()

    raise ValueError(
        f"No AbstractGrader subclass found in {grader_path}"
    )
