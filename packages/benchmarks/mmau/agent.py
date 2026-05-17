"""Compatibility shim for legacy ``benchmarks.mmau.agent`` imports."""

from ._compat import ensure_mmau_audio_path

ensure_mmau_audio_path()

from elizaos_mmau_audio.agent import *  # noqa: F401, F403
