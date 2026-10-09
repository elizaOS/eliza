"""Pins authored co-parent calendar weekdays to their structural timestamps."""

from datetime import date

from eliza_lifeops_bench.scenarios.co_parenting import CO_PARENTING_SCENARIOS


def test_custody_rhythm_starts_on_the_authored_friday() -> None:
    scenario = next(
        item
        for item in CO_PARENTING_SCENARIOS
        if item.id == "j1.coparenting.custody_rhythm_capture"
    )
    action = scenario.ground_truth_actions[0]

    assert date.fromisoformat("2026-05-15").weekday() == 4
    assert "Friday 2026-05-15" in scenario.instruction
    assert action.kwargs["details"]["start"] == "2026-05-15T16:30:00Z"
    assert action.kwargs["details"]["end"] == "2026-05-15T17:00:00Z"
