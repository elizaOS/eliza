"""VoiceAgentBench - voice-in + tool-call-out + multi-turn benchmark.

Vendors the VoiceAgentBench task suite (Patil et al., 2025;
https://arxiv.org/html/2510.07978v1) into Milady's benchmark harness.
5,757 voice queries across six suites:

  * ``single``       - single tool call from a voice query
  * ``parallel``     - multiple independent tool calls from one voice query
  * ``sequential``   - tool calls where output of call N feeds call N+1
  * ``multi-turn``   - multi-turn dialogue with tool calls across turns
  * ``safety``       - refusal / disallowed-tool cases
  * ``multilingual`` - non-English voice queries (English tool surfaces)

Audio bytes are conveyed on the new ``MessageTurn`` (subclass of the
LifeOpsBench ``MessageTurn``) via the additive ``audio_input`` /
``audio_output`` fields. Cascaded-STT adapters transcribe ``audio_input``
to text via Groq Whisper before their text path; direct-audio adapters
may consume ``audio_input`` directly.
"""

from __future__ import annotations

from .types import (
    AgentFn,
    AudioQuery,
    MessageTurn,
    SafetyVerdict,
    Suite,
    ToolCallExpectation,
    VoiceTask,
    VoiceTaskResult,
    VoiceBenchmarkReport,
)

__version__ = "0.1.0"
__all__ = [
    "AgentFn",
    "AudioQuery",
    "MessageTurn",
    "SafetyVerdict",
    "Suite",
    "ToolCallExpectation",
    "VoiceTask",
    "VoiceTaskResult",
    "VoiceBenchmarkReport",
]
