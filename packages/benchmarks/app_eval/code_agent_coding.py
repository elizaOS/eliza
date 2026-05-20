"""Import wrapper for ``packages/benchmarks/app-eval/code_agent_coding.py``."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any


def _load_impl() -> Any:
    path = Path(__file__).resolve().parents[1] / "app-eval" / "code_agent_coding.py"
    spec = importlib.util.spec_from_file_location("benchmarks_app_eval_code_agent_coding_impl", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load App Eval coding wrapper from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_impl = _load_impl()

app_eval_root = _impl.app_eval_root
agent_command_template = _impl.agent_command_template
build_result = _impl.build_result
evaluate_workspace = _impl.evaluate_workspace
load_tasks = _impl.load_tasks
run_agent_app_eval_coding = _impl.run_agent_app_eval_coding
main = _impl.main


if __name__ == "__main__":
    raise SystemExit(main())
