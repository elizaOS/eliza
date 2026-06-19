# mmau — Legacy Import Shim

Compatibility shim that redirects old `benchmarks.mmau.*` imports to
`elizaos_mmau_audio`, the package that lives in [`../mmau-audio/`](../mmau-audio/).
The real benchmark logic, dataset loading, evaluation, and CLI all live there.

## Why this exists

When the MMAU benchmark was extracted into its own installable package
(`elizaos_mmau_audio`), existing code that imported `benchmarks.mmau.*` would
have broken. This shim preserves those import paths without copying any logic.

## Files

| File | Role |
|---|---|
| `_compat.py` | Inserts `../mmau-audio/` into `sys.path` when the package is not installed |
| `__init__.py` | Re-exports every public symbol from `elizaos_mmau_audio` |
| `__main__.py` | Entry point for `python -m benchmarks.mmau`; delegates to `elizaos_mmau_audio.cli.main` |
| `agent.py` | Shim for `benchmarks.mmau.agent` imports |
| `cli.py` | Shim for `benchmarks.mmau.cli` imports |
| `dataset.py` | Shim for `benchmarks.mmau.dataset` imports |
| `evaluator.py` | Shim for `benchmarks.mmau.evaluator` imports |
| `runner.py` | Shim for `benchmarks.mmau.runner` imports |
| `types.py` | Shim for `benchmarks.mmau.types` imports |

## Usage

Prefer importing from `elizaos_mmau_audio` directly in new code.
Legacy imports continue to work unchanged:

```python
# legacy — still works via this shim
from benchmarks.mmau import MMAURunner, MMAUEvaluator

# preferred for new code
from elizaos_mmau_audio import MMAURunner, MMAUEvaluator
```
