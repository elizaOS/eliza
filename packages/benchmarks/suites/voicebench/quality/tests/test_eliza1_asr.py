"""VoiceBench connects its async STT adapter to the shared local transport."""

import asyncio

from benchmarks.lib import Eliza1ASR
from elizaos_voicebench.adapters import _build_stt


def test_build_stt_selects_shared_transport(monkeypatch):
    async def transcribe(self, audio):
        return "measured"

    monkeypatch.setattr(Eliza1ASR, "transcribe", transcribe)
    assert asyncio.run(_build_stt("eliza1")(b"RIFF")) == "measured"
