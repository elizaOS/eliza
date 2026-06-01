# app_eval — Python import shim for the app-eval benchmark

This directory is a thin import-compatibility layer that bridges the Python package
namespace (`benchmarks.app_eval`) to the actual benchmark implementation in the
sibling `../app-eval/` directory. It is not a standalone benchmark.

## Files

| File | Purpose |
|---|---|
| `__init__.py` | Marks the directory as a Python package; documents its role as an import shim. |
| `code_agent_coding.py` | Dynamically loads `../app-eval/code_agent_coding.py` via `importlib` and re-exports its public symbols (`app_eval_root`, `agent_command_template`, `build_result`, `evaluate_workspace`, `load_tasks`, `run_agent_app_eval_coding`, `main`). |

## Usage

This package is imported dynamically by `orchestrator/code_agent_matrix.py` when
scheduling `app_eval_coding` matrix cells:

```python
import importlib
mod = importlib.import_module("benchmarks.app_eval.code_agent_coding")
```

`orchestrator/random_baseline_runner.py` also references `app-eval` result payloads
(via `summary.json`). Do not invoke this package directly; run benchmarks through
the orchestrator instead (see `../AGENTS.md`).
