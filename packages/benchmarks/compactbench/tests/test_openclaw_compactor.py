from __future__ import annotations

from pathlib import Path
import sys
from typing import Any

from compactbench.contracts import Transcript, Turn, TurnRole

COMPACTBENCH_ROOT = Path(__file__).resolve().parents[1]
if str(COMPACTBENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(COMPACTBENCH_ROOT))

from eliza_compactbench.openclaw_compactor import OpenClawNativeToolCompactor
from openclaw_adapter.client import MessageResponse


class _StubProvider:
    key = "stub"

    async def complete(self, _request: Any) -> Any:
        raise RuntimeError("OpenClaw compactor must route through OpenClawClient")


class _FakeOpenClawClient:
    provider = "cerebras"

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send_message(self, text: str, context: dict[str, object] | None = None) -> MessageResponse:
        self.calls.append({"text": text, "context": context})
        return MessageResponse(
            text="",
            thought=None,
            actions=["emit_compaction_artifact"],
            params={
                "tool_calls": [
                    {
                        "id": "call_0",
                        "name": "emit_compaction_artifact",
                        "arguments": {
                            "summary_text": "Alice wants lunch with Bob tomorrow.",
                            "immutable_facts": ["Alice mentioned Bob."],
                            "locked_decisions": ["Discuss lunch tomorrow."],
                            "deferred_items": [],
                            "forbidden_behaviors": [],
                            "entity_map": {"Alice": "user", "Bob": "contact"},
                            "unresolved_items": [],
                            "selected_source_turn_ids": [1],
                            "warnings": [],
                        },
                    }
                ],
                "_meta": {
                    "openclaw_adapter": {
                        "transport": "direct_openai_compatible",
                        "native_openai_tool_calls": True,
                    }
                },
            },
        )


async def test_openclaw_compactor_uses_native_tool_call_artifact() -> None:
    client = _FakeOpenClawClient()
    compactor = OpenClawNativeToolCompactor(
        provider=_StubProvider(),
        model="gpt-oss-120b",
        client=client,  # type: ignore[arg-type]
    )
    transcript = Transcript(
        turns=[Turn(id=1, role=TurnRole.USER, content="Alice asks Bob about lunch")]
    )

    artifact = await compactor.compact(transcript)

    assert client.calls
    context = client.calls[0]["context"]
    assert isinstance(context, dict)
    assert context["tool_choice"] == "required"
    assert artifact.summary_text == "Alice wants lunch with Bob tomorrow."
    assert artifact.structured_state.entity_map["Bob"] == "contact"
    assert artifact.selected_source_turn_ids == [1]
    assert artifact.method_metadata["agent_family"] == "openclaw"
    assert artifact.method_metadata["native_tool_calls"] is True
