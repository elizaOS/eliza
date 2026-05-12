from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any

import pytest
from compactbench.contracts import Transcript, Turn, TurnRole

COMPACTBENCH_ROOT = Path(__file__).resolve().parents[1]
if str(COMPACTBENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(COMPACTBENCH_ROOT))

from eliza_compactbench.openclaw_compactor import (
    OpenClawCompactionUnsupportedError,
    OpenClawNativeCompactor,
    openclaw_compaction_status,
)
from run_openclaw import main as run_openclaw_main


class _StubProvider:
    key = "stub"

    async def complete(self, _request: Any) -> Any:
        raise RuntimeError("OpenClaw unsupported adapter must not call provider")


async def test_openclaw_compactor_fails_closed_without_oracle_fallback() -> None:
    compactor = OpenClawNativeCompactor(provider=_StubProvider(), model="gpt-oss-120b")
    transcript = Transcript(
        turns=[Turn(id=1, role=TurnRole.USER, content="remember this")]
    )

    with pytest.raises(OpenClawCompactionUnsupportedError, match="does not expose"):
        await compactor.compact(transcript)


def test_openclaw_compaction_status_is_explicitly_unsupported() -> None:
    status = openclaw_compaction_status()

    assert status["agent"] == "openclaw"
    assert status["benchmark"] == "compactbench"
    assert status["supported"] is False
    assert status["no_oracle_fallback"] is True
    assert status["no_eliza_fallback"] is True


def test_run_openclaw_writes_unsupported_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "openclaw-compactbench.jsonl"
    monkeypatch.setattr(
        "sys.argv",
        ["run_openclaw.py", "--output", str(output), "--expect-unsupported"],
    )

    assert run_openclaw_main() == 0
    event = json.loads(output.read_text(encoding="utf-8"))
    assert event["event"] == "adapter_unsupported"
    assert event["agent"] == "openclaw"
    assert event["supported"] is False
