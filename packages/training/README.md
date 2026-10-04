# Eliza-1 training

Training, evaluation, quantization, and publishing tools for Eliza-1. Model
choices and hardware requirements live in `scripts/training/model_registry.py`.
Generated models and private datasets stay outside version control.

Use Python 3.11 or 3.12 and uv from a complete repository checkout. From this
directory, install the CPU development environment and run its checks:

```bash
uv sync --extra dev
uv run --extra dev python -m pytest
uv run --extra dev ruff check scripts tests --select F,E9,B023,B033,PLR0124
uv run --extra dev python setup.py build_py
uv run --extra dev ty check scripts/publish scripts/release --extra-search-path build/lib
```

The type check covers the release boundary; legacy and optional accelerator
modules still have separate typing debt. Rebuild `build/lib` after moving modules.
Run repository checks with the pinned Bun and Node versions from the root.

The installed Python namespace is `eliza_training`; use domain modules such as
`uv run python -m eliza_training.publish.publish_eliza1_all --help`. Operator
script paths remain in `scripts/`. Internal imports use their owning module;
domain public APIs keep optional accelerator dependencies lazy. Tests stay in
the checkout and are excluded from built Python packages. Operator workflows
also use repository assets and are not standalone wheel applications.

Install `--extra train` for accelerator training; `serve`, `rl`, and `rl-tinker`
provide their respective optional integrations. Voice recipes also declare their
own requirements. Kokoro full training uses `scripts/kokoro/finetune_kokoro_full.py`;
the obsolete missing-adapter/experimental trainer and its wrapper were retired.
Publication requires Hugging Face credentials and an evaluated exported artifact.
Runtime voice metadata belongs to the native inference plugin; append versions
with `scripts/append_voice_model_version.py --registry PATH` using an upload receipt.

Preserve complete model requests and responses; reject oversized training rows
instead of truncating them. Dataset transforms require explicit input/output and
refuse to rewrite recorded native boundaries. Never substitute estimated metrics
for measured evaluation results.
