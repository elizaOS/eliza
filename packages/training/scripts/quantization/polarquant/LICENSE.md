# Vendored PolarQuant — Upstream License Notice

The two Python modules in this directory (`polar_quant.py`, `utils.py`) are
copied verbatim from the public reference implementation maintained by the
PolarQuant author Caio Vicentino. Upstream details:

- Repository: https://github.com/caiovicentino/eoq-quantization
- Commit pinned: `15a12160245d7d3015290c6c5b6dbb7f22094d5e` (May 2026)
- Files copied: `core/polar_quant.py`, `core/utils.py`
- Paper: *PolarQuant: Optimal Gaussian Weight Quantization via Hadamard
  Rotation for LLM Compression*, Caio Vicentino, arXiv:2603.29078 (March 2026).
  The arXiv preprint was withdrawn by the author with a follow-up note about
  errata; the repository implementation cited above remains the working
  reference and is what this vendoring relies on.

## License status

As of the pinned commit the upstream repository ships **no LICENSE file** and
GitHub's license API returns `false`. We have not received an explicit grant
from the author. We vendor these two source files for the limited purpose of
running PolarQuant on our own fine-tuned Qwen checkpoints inside this
research training pipeline, and we cite the upstream source and authors here
and in `polar_quant.py`'s module docstring.

If the upstream maintainer publishes a license that disallows this use, this
vendored copy MUST be removed from the repo and replaced with an equivalent
clean-room implementation, or with a pip dependency once one is published.

If you are the upstream author and would like attribution corrections, license
clarification, or removal, please open an issue against the eliza/training
repository.
