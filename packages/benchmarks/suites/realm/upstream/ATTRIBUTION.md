# Upstream Attribution

The contents of this directory (excluding `evaluation/__init__.py`, which
was thinned to avoid hard third-party deps) are vendored verbatim from:

> **REALM-Bench: A Real-World Planning Benchmark for LLMs and Multi-Agent Systems**
> Geng et al., 2025. arXiv: <https://arxiv.org/abs/2502.18836>
> GitHub: <https://github.com/genglongling/REALM-Bench>

## What is vendored

- `evaluation/` - task definitions, six standard metric families, the
  upstream evaluator pipeline.
- `datasets/P1` ... `datasets/P10` - instance JSON files plus generator
  scripts.
- `datasets/P11` - JSSP benchmark instances (DMU, TA, abz/swv/yn) copied
  from upstream `datasets/J1/`.
- `datasets/README.md` and the top-level upstream README.

## Authors / contributors

From the upstream GitHub contributor list at the time of vendoring:

- **genglongling** (Geng Longling, primary author - 26 commits)
- **LeonieFreisinger** (Leonie Freisinger - 24 commits)

Canonical list: <https://github.com/genglongling/REALM-Bench/graphs/contributors>.

## Citation

```bibtex
@article{geng2025realmbench,
  title   = {REALM-Bench: A Real-World Planning Benchmark for LLMs and
             Multi-Agent Systems},
  author  = {Geng, Longling and others},
  journal = {arXiv preprint arXiv:2502.18836},
  year    = {2025}
}
```

## License

**Upstream has no LICENSE file** at the cloned snapshot. As of May 2026
neither the `main` / `master` branches nor the GitHub repository surface
carries a `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING`, or license
badge - verified via:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://raw.githubusercontent.com/genglongling/REALM-Bench/main/LICENSE
# -> 404
curl -s https://api.github.com/repos/genglongling/REALM-Bench/license
# -> {"message": "Not Found", "status": "404"}
```

In the absence of an explicit license declaration, the upstream code and
datasets have ambiguous redistribution terms. The attribution above is
not a license grant and is not a legal conclusion. This package preserves
the vendored material for benchmark reproducibility with full research
citation; downstream consumers who need redistribution, commercial use,
or a stronger guarantee should:

1. Contact the upstream maintainers to clarify the intended license.
2. Treat this directory as governed by whichever license the upstream
   subsequently publishes - copy that file into `upstream/LICENSE` and
   remove this note when it appears.
3. (Recommended) Open a GitHub issue on the upstream repo asking the
   authors to add a `LICENSE` file (e.g. MIT, Apache-2.0, or
   CC-BY-4.0 for the dataset). **We have not opened this issue ourselves.**

This package's local code (everything outside `upstream/`) is part of
the elizaOS monorepo and inherits the elizaOS license.

If you regenerate `upstream/` from a fresh clone, you do not need to
copy `.git/` or the upstream venv directory.
