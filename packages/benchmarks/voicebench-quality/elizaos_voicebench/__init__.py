"""VoiceBench (Chen et al. 2024) vendored as native Python.

Upstream: https://github.com/MatthewCYM/VoiceBench (Apache-2.0)
Paper:    https://arxiv.org/abs/2410.17196

Eight task suites over 6783 spoken instructions: alpacaeval, commoneval,
sd-qa, ifeval, advbench, openbookqa, mmsu, bbh. Audio is hosted on
Hugging Face (``hlt-mt/VoiceBench``) and pulled lazily on first run; no
audio is bundled.
"""

from __future__ import annotations

from .types import SUITES, Sample, SuiteId, SuiteResult, VoiceBenchResult

__all__ = [
    "SUITES",
    "Sample",
    "SuiteId",
    "SuiteResult",
    "VoiceBenchResult",
]

__version__ = "0.1.0"
