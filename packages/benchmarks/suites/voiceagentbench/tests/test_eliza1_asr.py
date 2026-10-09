"""VoiceAgentBench connects its STT adapter to the shared local transport."""

from benchmarks.lib import Eliza1ASR
from elizaos_voiceagentbench.stt import build_stt
from elizaos_voiceagentbench.types import AudioQuery


def test_build_stt_selects_shared_transport(monkeypatch):
    monkeypatch.setattr(
        Eliza1ASR, "transcribe_bytes", lambda self, audio, **kw: "measured"
    )
    stt = build_stt(provider="eliza1")
    assert (
        stt.transcribe(AudioQuery(audio_bytes=b"RIFF", transcript="gt", language="en"))
        == "measured"
    )
