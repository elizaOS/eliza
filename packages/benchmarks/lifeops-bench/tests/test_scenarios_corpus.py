"""Tests for the hand-authored Wave 2A scenario corpus.

These tests are the gate: every scenario in ``ALL_SCENARIOS`` must use
real action names from the manifest and reference real entity ids in the
cited snapshot. Coverage and persona-shape sanity checks are also
enforced here so adding a regression breaks the suite.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from eliza_lifeops_bench.scenarios import ALL_SCENARIOS, SCENARIOS_BY_DOMAIN
from eliza_lifeops_bench.types import Domain

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PACKAGE_ROOT / "manifests" / "actions.manifest.json"
SNAPSHOTS_DIR = PACKAGE_ROOT / "data" / "snapshots"

ID_PREFIX_TO_KIND: dict[str, str] = {
    "contact_": "contact",
    "event_": "calendar_event",
    "cal_": "calendar",
    "list_": "reminder_list",
    "reminder_": "reminder",
    "email_": "email",
    "thread_": "email_thread",
    "conv_": "conversation",
    "chat_": "chat_message",
    "sub_": "subscription",
    "account_": "account",
    "txn_": "transaction",
    "note_": "note",
}

# Known seed-id whitelist for prefixes that collide with action-verb strings
# (e.g. ``list_channels`` is a subaction value, not a reminder_list id).
KNOWN_REMINDER_LISTS: set[str] = {"list_inbox", "list_personal", "list_work"}


@pytest.fixture(scope="module")
def manifest_action_names() -> set[str]:
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {entry["function"]["name"] for entry in raw["actions"]}


@pytest.fixture(scope="module")
def world_ids_by_seed() -> dict[int, dict[str, set[str]]]:
    out: dict[int, dict[str, set[str]]] = {}
    for seed, name in ((42, "tiny_seed_42"), (2026, "medium_seed_2026")):
        raw = json.loads((SNAPSHOTS_DIR / f"{name}.json").read_text(encoding="utf-8"))
        out[seed] = {kind: set(items.keys()) for kind, items in raw["stores"].items()}
    return out


def test_corpus_size_meets_minimum() -> None:
    assert len(ALL_SCENARIOS) >= 40, (
        f"Wave 2A baseline is 40 hand-authored scenarios; have {len(ALL_SCENARIOS)}"
    )


def test_unique_scenario_ids() -> None:
    ids = [s.id for s in ALL_SCENARIOS]
    assert len(ids) == len(set(ids)), "duplicate scenario ids"


def test_every_action_name_exists_in_manifest(manifest_action_names: set[str]) -> None:
    bad: list[tuple[str, str]] = []
    for scenario in ALL_SCENARIOS:
        for action in scenario.ground_truth_actions:
            if action.name not in manifest_action_names:
                bad.append((scenario.id, action.name))
    assert not bad, f"unknown action names: {bad}"


def test_every_domain_has_minimum_coverage() -> None:
    for domain in Domain:
        present = SCENARIOS_BY_DOMAIN.get(domain, [])
        assert len(present) >= 3, (
            f"domain {domain.value} has only {len(present)} scenarios; need >= 3"
        )


def _looks_like_entity_id(value: str) -> bool:
    """Return True only for ``<prefix><digits>`` strings.

    Seed entity ids are always digit-suffixed (e.g. ``event_00040``). This
    avoids matching subaction verbs like ``list_channels`` against the
    ``list_`` prefix.
    """
    for prefix in ID_PREFIX_TO_KIND:
        if value.startswith(prefix):
            suffix = value[len(prefix):]
            if suffix and suffix.isdigit():
                return True
            if value in KNOWN_REMINDER_LISTS:
                return True
    return False


def _walk_for_ids(value: object, found: list[str]) -> None:
    if isinstance(value, str):
        if _looks_like_entity_id(value):
            found.append(value)
        return
    if isinstance(value, list):
        for item in value:
            _walk_for_ids(item, found)
    elif isinstance(value, dict):
        for v in value.values():
            _walk_for_ids(v, found)


def test_referenced_world_ids_exist_in_snapshot(
    world_ids_by_seed: dict[int, dict[str, set[str]]],
) -> None:
    bad: list[tuple[str, str, str]] = []
    for scenario in ALL_SCENARIOS:
        snap = world_ids_by_seed.get(scenario.world_seed)
        if snap is None:
            bad.append((scenario.id, str(scenario.world_seed), "no snapshot for seed"))
            continue
        for action in scenario.ground_truth_actions:
            ids: list[str] = []
            _walk_for_ids(action.kwargs, ids)
            for entity_id in ids:
                kind = next(
                    (
                        ID_PREFIX_TO_KIND[p]
                        for p in ID_PREFIX_TO_KIND
                        if entity_id.startswith(p)
                    ),
                    None,
                )
                if kind is None:
                    continue
                if entity_id not in snap.get(kind, set()):
                    bad.append((scenario.id, entity_id, kind))
    assert not bad, f"scenario references non-existent world ids: {bad}"


def test_at_least_30_percent_have_first_question_fallback() -> None:
    # The fallback contract applies only to STATIC scenarios. LIVE scenarios
    # are scored by the LLM judge and the persona answers clarifiers freely,
    # so first_question_fallback is always None for them by design.
    from eliza_lifeops_bench.types import ScenarioMode

    static = [s for s in ALL_SCENARIOS if s.mode == ScenarioMode.STATIC]
    with_fallback = sum(1 for s in static if s.first_question_fallback is not None)
    ratio = with_fallback / len(static)
    assert ratio >= 0.30, (
        f"at least 30% of STATIC scenarios must have a first_question_fallback; got {ratio:.0%}"
    )


def test_live_scenarios_are_unscripted() -> None:
    from eliza_lifeops_bench.types import ScenarioMode

    live = [s for s in ALL_SCENARIOS if s.mode == ScenarioMode.LIVE]
    assert live, "expected at least one LIVE scenario in the corpus"
    assert all(s.ground_truth_actions == [] for s in live)
    assert all(s.required_outputs == [] for s in live)
    assert all(s.first_question_fallback is None for s in live)
    assert all(getattr(s, "success_criteria", []) for s in live)
    assert all(getattr(s, "world_assertions", []) for s in live)


def test_persona_shape_sane() -> None:
    bad: list[str] = []
    for scenario in ALL_SCENARIOS:
        persona = scenario.persona
        if not persona.id or not persona.name or not persona.background:
            bad.append(f"{scenario.id} has incomplete persona")
        if not persona.traits:
            bad.append(f"{scenario.id} persona has no traits")
        if not persona.communication_style:
            bad.append(f"{scenario.id} persona has no communication_style")
        if persona.patience_turns < 5:
            bad.append(
                f"{scenario.id} persona patience_turns {persona.patience_turns} < 5"
            )
    assert not bad, "persona issues:\n" + "\n".join(bad)


def test_description_and_instruction_non_empty() -> None:
    bad: list[str] = []
    for scenario in ALL_SCENARIOS:
        if not scenario.description.strip():
            bad.append(f"{scenario.id}: empty description")
        if not scenario.instruction.strip():
            bad.append(f"{scenario.id}: empty instruction")
    assert not bad, "issues:\n" + "\n".join(bad)


def test_authoring_validator_is_importable() -> None:
    """Smoke test that the candidate-generator pipeline modules import cleanly."""
    from eliza_lifeops_bench.scenarios._authoring import (
        generate_candidates,
        import_reviewed,
        validate,
    )

    assert hasattr(validate, "validate_candidate")
    assert hasattr(generate_candidates, "main")
    assert hasattr(import_reviewed, "main")


def test_authoring_validator_accepts_a_real_scenario() -> None:
    """Round-trip: rendering a hand-authored scenario as JSON candidate validates."""
    from eliza_lifeops_bench.scenarios._authoring.validate import validate_batch

    scenario = ALL_SCENARIOS[2]  # not the smokes
    fallback = scenario.first_question_fallback
    candidate = {
        "id": scenario.id,
        "name": scenario.name,
        "domain": scenario.domain.value,
        "mode": scenario.mode.value,
        "persona_id": scenario.persona.id,
        "instruction": scenario.instruction,
        "ground_truth_actions": [
            {"name": a.name, "kwargs": a.kwargs}
            for a in scenario.ground_truth_actions
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
    }
    snapshot_name = (
        "tiny_seed_42" if scenario.world_seed == 42 else "medium_seed_2026"
    )
    results = validate_batch(
        [candidate],
        manifest_path=MANIFEST_PATH,
        snapshot_path=SNAPSHOTS_DIR / f"{snapshot_name}.json",
    )
    assert results[0].is_valid, (
        "round-trip validation failed: " + str(results[0].issues)
    )


def test_authoring_validator_rejects_fake_action_name() -> None:
    from eliza_lifeops_bench.scenarios._authoring.validate import validate_batch

    candidate = {
        "id": "calendar.bogus",
        "name": "bogus",
        "domain": "calendar",
        "mode": "static",
        "persona_id": "alex_eng",
        "instruction": "do the bogus thing",
        "ground_truth_actions": [
            {"name": "CALENDAR_BOGUS_ACTION", "kwargs": {}}
        ],
        "required_outputs": [],
        "first_question_fallback": None,
        "world_seed": 2026,
        "max_turns": 5,
        "description": "regression test",
    }
    results = validate_batch(
        [candidate],
        manifest_path=MANIFEST_PATH,
        snapshot_path=SNAPSHOTS_DIR / "medium_seed_2026.json",
    )
    assert not results[0].is_valid
    assert any(
        "CALENDAR_BOGUS_ACTION" in i.message
        for i in results[0].issues
    ), results[0].issues


def test_authoring_validator_rejects_fake_entity_id() -> None:
    from eliza_lifeops_bench.scenarios._authoring.validate import validate_batch

    candidate = {
        "id": "calendar.fake_event",
        "name": "fake event",
        "domain": "calendar",
        "mode": "static",
        "persona_id": "alex_eng",
        "instruction": "cancel a fake event",
        "ground_truth_actions": [
            {
                "name": "CALENDAR",
                "kwargs": {
                    "subaction": "delete_event",
                    "details": {"eventId": "event_99999", "calendarId": "cal_primary"},
                },
            }
        ],
        "required_outputs": [],
        "first_question_fallback": None,
        "world_seed": 2026,
        "max_turns": 5,
        "description": "regression test for fake id rejection",
    }
    results = validate_batch(
        [candidate],
        manifest_path=MANIFEST_PATH,
        snapshot_path=SNAPSHOTS_DIR / "medium_seed_2026.json",
    )
    assert not results[0].is_valid
    assert any("event_99999" in i.message for i in results[0].issues)
