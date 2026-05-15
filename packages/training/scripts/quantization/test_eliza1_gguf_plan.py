from __future__ import annotations

import copy
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from validate_eliza1_gguf_plan import (  # noqa: E402
    QWEN35_TIERS,
    QWEN36_27B_TIERS,
    load_plan,
    validate_plan,
)


def test_checked_in_plan_validates_offline() -> None:
    assert validate_plan(load_plan()) == []


def test_lower_tiers_do_not_hardcode_missing_qwen36_repos() -> None:
    plan = load_plan()
    tiers = plan["tiers"]
    for tier in QWEN35_TIERS:
        assert tiers[tier]["family"] == "qwen3.5"
        assert not tiers[tier]["sourceModel"].startswith("Qwen/Qwen3.6-")


def test_27b_context_variants_share_official_qwen36_source() -> None:
    plan = load_plan()
    tiers = plan["tiers"]
    for tier in QWEN36_27B_TIERS:
        assert tiers[tier]["sourceModel"] == "Qwen/Qwen3.6-27B"
        assert tiers[tier]["ggufSeed"]["repo"] == "unsloth/Qwen3.6-27B-GGUF"


def test_validator_rejects_invented_lower_qwen36_source() -> None:
    plan = copy.deepcopy(load_plan())
    plan["tiers"]["2b"]["family"] = "qwen3.6"
    plan["tiers"]["2b"]["sourceModel"] = "Qwen/Qwen3.6-2B-Base"

    errors = validate_plan(plan)

    assert any("tiers.2b.family" in error for error in errors)
    assert any("lower tiers must not invent" in error for error in errors)
