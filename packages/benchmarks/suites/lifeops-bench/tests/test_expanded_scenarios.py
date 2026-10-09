"""Contract checks for the expanded LifeOpsBench scenario packs."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from eliza_lifeops_bench.scenarios.expanded import EXPANDED_AREA_GAPS, EXPANDED_SCENARIOS
from eliza_lifeops_bench.scenarios._authoring.validate import validate_batch
from eliza_lifeops_bench.types import ScenarioMode

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PACKAGE_ROOT / "manifests" / "actions.manifest.json"
SNAPSHOT_PATH = PACKAGE_ROOT / "data" / "snapshots" / "medium_seed_2026.json"


def _area_id(scenario_id: str) -> str:
    parts = scenario_id.split(".")
    if parts[0] == "live":
        assert parts[1] == "expanded"
        return parts[2]
    assert parts[0] == "expanded"
    return parts[1]


def _expanded_id_parts(scenario_id: str) -> tuple[str, str, str]:
    parts = scenario_id.split(".")
    if parts[0] == "live":
        assert parts[1] == "expanded"
        return parts[2], parts[3], parts[4]
    assert parts[0] == "expanded"
    return parts[1], parts[2], parts[3]


def test_expanded_scenario_pack_shape() -> None:
    assert len(EXPANDED_SCENARIOS) == 300
    by_area = Counter(_area_id(s.id) for s in EXPANDED_SCENARIOS)
    assert len(by_area) == 10
    assert set(by_area.values()) == {30}


def test_expanded_scenarios_have_primary_and_two_variants() -> None:
    by_family: dict[tuple[str, str], set[str]] = {}
    for scenario in EXPANDED_SCENARIOS:
        area, family, variant = _expanded_id_parts(scenario.id)
        by_family.setdefault((area, family), set()).add(variant)

    assert len(by_family) == 100
    assert set(map(frozenset, by_family.values())) == {
        frozenset({"primary", "variant_a", "variant_b"})
    }


def test_expanded_scenarios_include_static_live_and_fallbacks_per_area() -> None:
    for area in EXPANDED_AREA_GAPS:
        scenarios = [s for s in EXPANDED_SCENARIOS if _area_id(s.id) == area]
        static = [s for s in scenarios if s.mode is ScenarioMode.STATIC]
        live = [s for s in scenarios if s.mode is ScenarioMode.LIVE]
        with_fallback = [s for s in static if s.first_question_fallback is not None]
        assert len(static) == 18, area
        assert len(live) == 12, area
        assert len(with_fallback) == 12, area
        assert all(s.ground_truth_actions == [] for s in live), area
        assert all(s.required_outputs == [] for s in live), area
        assert all(s.first_question_fallback is None for s in live), area


def _freeze(value: object) -> object:
    if isinstance(value, dict):
        return tuple(sorted((k, _freeze(v)) for k, v in value.items()))
    if isinstance(value, list):
        return tuple(_freeze(v) for v in value)
    if isinstance(value, tuple):
        return tuple(_freeze(v) for v in value)
    return value


def _static_signature(scenario: object) -> tuple[object, ...]:
    sig: list[tuple[str, object]] = []
    for action in scenario.ground_truth_actions:
        kwargs = {
            key: value
            for key, value in action.kwargs.items()
            if key != "promptInstructions"
        }
        trigger = kwargs.get("trigger")
        if isinstance(trigger, dict):
            kwargs["trigger"] = {
                key: value for key, value in trigger.items() if key != "atIso"
            }
        metadata = kwargs.get("metadata")
        if isinstance(metadata, dict):
            kwargs["metadata"] = {
                key: value for key, value in metadata.items() if key != "variant"
            }
        sig.append((action.name, _freeze(kwargs)))
    return tuple(sig)


def test_expanded_static_families_have_distinct_variant_shapes() -> None:
    by_family: dict[tuple[str, str], list[object]] = {}
    for scenario in EXPANDED_SCENARIOS:
        area, family, variant = _expanded_id_parts(scenario.id)
        if scenario.mode is ScenarioMode.STATIC:
            by_family.setdefault((area, family), []).append(scenario)

    weak = {
        key: [scenario.id for scenario in scenarios]
        for key, scenarios in by_family.items()
        if len({_static_signature(s) for s in scenarios}) == 1
    }
    assert not weak, f"static families with duplicate variant shapes: {weak}"


def test_expanded_scenarios_validate_against_manifest() -> None:
    candidates = []
    for scenario in EXPANDED_SCENARIOS:
        fallback = scenario.first_question_fallback
        candidates.append(
            {
                "id": scenario.id,
                "name": scenario.name,
                "domain": scenario.domain.value,
                "mode": scenario.mode.value,
                "persona_id": scenario.persona.id,
                "instruction": scenario.instruction,
                "ground_truth_actions": [
                    {"name": action.name, "kwargs": action.kwargs}
                    for action in scenario.ground_truth_actions
                ],
                "required_outputs": list(scenario.required_outputs),
                "first_question_fallback": (
                    None
                    if fallback is None
                    else {
                        "canned_answer": fallback.canned_answer,
                        "applies_when": fallback.applies_when,
                    }
                ),
                "world_seed": scenario.world_seed,
                "max_turns": scenario.max_turns,
                "description": scenario.description,
                "success_criteria": list(getattr(scenario, "success_criteria", [])),
                "world_assertions": list(getattr(scenario, "world_assertions", [])),
            }
        )

    results = validate_batch(
        candidates,
        manifest_path=MANIFEST_PATH,
        snapshot_path=SNAPSHOT_PATH,
    )
    bad = [result for result in results if not result.is_valid]
    assert not bad, "\n".join(
        f"{result.candidate_id}: {result.issues}" for result in bad[:10]
    )


def test_expanded_scenarios_document_missing_runtime_semantics() -> None:
    assert set(EXPANDED_AREA_GAPS) == {_area_id(s.id) for s in EXPANDED_SCENARIOS}
    assert all(len(note.split()) >= 8 for note in EXPANDED_AREA_GAPS.values())
    assert any("not" in note.lower() or "no " in note.lower() for note in EXPANDED_AREA_GAPS.values())


def test_reviewed_expansion_areas_have_static_action_diversity() -> None:
    required_actions = {
        "focus_blockers": {
            "BLOCK_REQUEST_PERMISSION",
            "BLOCK_BLOCK",
            "BLOCK_STATUS",
            "BLOCK_RELEASE",
            "BLOCK_LIST_ACTIVE",
        },
        "finance_subscriptions": {
            "MONEY_SUBSCRIPTION_STATUS",
            "MONEY_SUBSCRIPTION_CANCEL",
            "MONEY_DASHBOARD",
            "MONEY_SPENDING_SUMMARY",
            "MONEY_LIST_TRANSACTIONS",
            "MONEY_SUBSCRIPTION_AUDIT",
        },
        "travel_docs_approvals": {
            "BOOK_TRAVEL",
            "CALENDAR",
            "LIFE_CREATE",
            "MESSAGE",
            "SCHEDULED_TASK_CREATE",
        },
        "multilocale_settings_privacy": {
            "SCHEDULED_TASK_CREATE",
            "SCHEDULED_TASK_UPDATE",
            "LIFE_SKIP",
            "ENTITY",
            "MESSAGE",
        },
    }
    for area, names in required_actions.items():
        scenarios = [
            s
            for s in EXPANDED_SCENARIOS
            if _area_id(s.id) == area and s.mode is ScenarioMode.STATIC
        ]
        action_names = {action.name for s in scenarios for action in s.ground_truth_actions}
        assert names.issubset(action_names), (area, names - action_names)


def test_finance_expansion_does_not_cancel_for_every_static_case() -> None:
    scenarios = [
        s
        for s in EXPANDED_SCENARIOS
        if _area_id(s.id) == "finance_subscriptions" and s.mode is ScenarioMode.STATIC
    ]
    cancel_count = sum(
        1
        for scenario in scenarios
        if any(action.name == "MONEY_SUBSCRIPTION_CANCEL" for action in scenario.ground_truth_actions)
    )
    assert 0 < cancel_count < len(scenarios) / 2
