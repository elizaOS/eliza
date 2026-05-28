"""Unit tests for AiNexExecutionService canonical intent mapping."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ainex-robot-code/eliza/packages/python"))

# Cross-package integration test: the AiNex plugin lives in a separate
# workspace package that is not installed in the robot venv. Skip cleanly
# when it is absent instead of erroring out at collection.
pytest.importorskip("elizaos_plugin_ainex")

from elizaos_plugin_ainex.execution_service import AinexExecutionService  # noqa: E402
from eliza_robot.interfaces import CanonicalIntentType  # noqa: E402


def test_build_canonical_intent_preserves_explicit_enum() -> None:
    service = AinexExecutionService(runtime=None)
    intent = service._build_canonical_intent(
        task="walk to the red ball",
        canonical_action="NAVIGATE_TO_ENTITY",
        target_entity_id="red-ball-01",
        target_label="Red Ball",
    )
    assert intent.intent == CanonicalIntentType.NAVIGATE_TO_ENTITY
    assert intent.target_entity_id == "red-ball-01"


def test_build_canonical_intent_maps_wave_to_emote() -> None:
    service = AinexExecutionService(runtime=None)
    intent = service._build_canonical_intent(
        task="wave hello",
        canonical_action="",
        target_entity_id="",
        target_label="",
    )
    assert intent.intent == CanonicalIntentType.EMOTE


def test_build_canonical_intent_maps_pickup_text() -> None:
    service = AinexExecutionService(runtime=None)
    intent = service._build_canonical_intent(
        task="pick up the red ball",
        canonical_action="",
        target_entity_id="red-ball-01",
        target_label="Red Ball",
    )
    assert intent.intent == CanonicalIntentType.PICKUP_ENTITY
