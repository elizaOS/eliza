"""Tests the real generation-admission policy without a provider dependency."""

from types import SimpleNamespace

import pytest

from .generation_integrity import (
    IncompleteGenerationError,
    require_complete_finish_reasons,
    require_complete_generated_tokens,
    require_complete_generation,
)


@pytest.mark.parametrize(
    "choice",
    [
        {"finish_reason": "length"},
        {"stopReason": "max_tokens"},
        SimpleNamespace(finish_reason="MAX_OUTPUT_TOKENS"),
    ],
)
def test_rejects_length_stopped_choices_with_denominator(choice: object) -> None:
    with pytest.raises(IncompleteGenerationError) as raised:
        require_complete_generation(choice, source="fixture")

    assert raised.value.rejection.as_dict() == {
        "code": "TRAINING_GENERATION_LENGTH_STOPPED",
        "source": "fixture",
        "finish_reason": require_reason(choice).lower(),
        "attempted": 1,
        "accepted": 0,
    }


def require_reason(choice: object) -> str:
    if isinstance(choice, dict):
        return str(next(iter(choice.values())))
    return str(choice.finish_reason)


def test_accepts_terminal_stop_and_tool_call_reasons() -> None:
    stop = {"finish_reason": "stop", "message": {"content": "complete"}}
    tool = SimpleNamespace(finish_reason="tool_calls")

    assert require_complete_generation(stop, source="fixture") is stop
    assert require_complete_generation(tool, source="fixture") is tool


def test_rejects_any_incomplete_multi_sample_member() -> None:
    with pytest.raises(IncompleteGenerationError) as raised:
        require_complete_finish_reasons(
            ["stop", "length", "tool_calls"], source="tinker"
        )

    assert raised.value.rejection.source == "tinker[1]"


def test_local_generation_requires_terminal_token_at_budget() -> None:
    with pytest.raises(IncompleteGenerationError):
        require_complete_generated_tokens(
            [10, 11, 12], max_new_tokens=3, source="local", terminal_token_ids=99
        )

    require_complete_generated_tokens(
        [10, 11, 99], max_new_tokens=3, source="local", terminal_token_ids=99
    )
