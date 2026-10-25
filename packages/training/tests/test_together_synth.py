"""Small successful synthesis batches must not report failure after rounding."""
import json
import sys
from types import SimpleNamespace

import pytest

from eliza_training.synth import together_synth


@pytest.mark.asyncio
@pytest.mark.parametrize("count,failed,expected", [(1, False, 0), (4, False, 0), (1, True, 1), (0, False, 1)])
async def test_batch_exit_status(tmp_path, monkeypatch, count, failed, expected):
    monkeypatch.setenv("TOGETHER_API_KEY", "test")
    monkeypatch.setitem(sys.modules, "together", SimpleNamespace(Together=lambda **kw: object()))
    monkeypatch.setattr(together_synth, "OUT_DIR", tmp_path / "output")

    async def call(*args, **kwargs):
        return {"error": "failed"} if failed else {"messages": [], "task_type": "test"}

    monkeypatch.setattr(together_synth, "call_together", call)
    scenarios = tmp_path / "scenarios.jsonl"
    scenarios.write_text("".join(json.dumps({"task_id": n}) + "\n" for n in range(count)))
    args = SimpleNamespace(scenarios=scenarios, max=0, model="test", concurrency=1)
    assert await together_synth.main_async(args) == expected
