# Upstream Attribution

The contents of this directory are vendored verbatim (with the exception of
`evaluation/__init__.py`, which was thinned to avoid hard third-party deps) from:

> **REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems**
> Geng et al., 2025. arXiv: https://arxiv.org/abs/2502.18836
> GitHub: https://github.com/genglongling/REALM-Bench

What is vendored:

- `evaluation/` — task definitions (`task_definitions.py`), six standard metric families
  (`metrics.py`), and the upstream evaluator pipeline (`evaluator.py`, requires pandas).
- `datasets/P1` … `datasets/P10` — instance JSON files plus generator scripts.
- `datasets/P11` — JSSP benchmark instances (DMU, TA, abz/swv/yn families) copied
  from upstream `datasets/J1/`.
- `datasets/README.md` and the top-level upstream README.

Upstream license: not present in the cloned snapshot (no `LICENSE` file in the
repo at the time of vendoring). Attribution is preserved here and in the
package README; if upstream publishes a license, downstream consumers should
treat this directory as governed by that license.

This package's local code (everything outside `upstream/`) is part of the
elizaOS monorepo and inherits the elizaOS license.

If you regenerate `upstream/` from a fresh clone, you do not need to copy
`.git/` or the upstream venv directory.
