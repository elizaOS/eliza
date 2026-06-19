"""Compatibility entry point for ``python -m benchmarks.mmau``."""

from ._compat import ensure_mmau_audio_path

ensure_mmau_audio_path()

from elizaos_mmau_audio.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
