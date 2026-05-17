"""Compatibility shim for legacy ``benchmarks.mmau.dataset`` imports."""

from ._compat import ensure_mmau_audio_path

ensure_mmau_audio_path()

from elizaos_mmau_audio.dataset import *  # noqa: F401, F403
