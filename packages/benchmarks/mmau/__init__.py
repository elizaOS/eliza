"""Compatibility shim for the renamed ``elizaos_mmau_audio`` package."""

from __future__ import annotations

import sys
from pathlib import Path

_AUDIO_ROOT = Path(__file__).resolve().parents[1] / "mmau-audio"
if str(_AUDIO_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUDIO_ROOT))

from elizaos_mmau_audio import *  # noqa: F401, F403
from elizaos_mmau_audio import __all__ as _AUDIO_ALL
from elizaos_mmau_audio import agent, cli, dataset, evaluator, runner, types

sys.modules[__name__ + ".agent"] = agent
sys.modules[__name__ + ".cli"] = cli
sys.modules[__name__ + ".dataset"] = dataset
sys.modules[__name__ + ".evaluator"] = evaluator
sys.modules[__name__ + ".runner"] = runner
sys.modules[__name__ + ".types"] = types

__all__ = list(_AUDIO_ALL)
