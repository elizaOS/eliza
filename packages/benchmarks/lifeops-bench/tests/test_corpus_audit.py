"""Guards the corpus-wide inference and no-effect audit against drift."""

from __future__ import annotations

import json
import re
from pathlib import Path

from eliza_lifeops_bench.corpus_audit import build_corpus_audit
from eliza_lifeops_bench.scenarios import CORE_SCENARIOS

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
AUDIT_PATH = PACKAGE_ROOT / "corpus-audit.json"


def test_generated_corpus_audit_is_current() -> None:
    committed = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))
    generated = build_corpus_audit()

    assert committed == generated


def test_live_openings_and_personas_have_no_hidden_bypass() -> None:
    audit = build_corpus_audit()
    corpus = audit["baseCorpus"]

    assert corpus["live"] == 738
    assert corpus["liveModelGeneratedOpenings"] == corpus["live"]
    assert corpus["liveAuthoredGoalLeaks"] == 0
    assert audit["personaIdsOutsideLibrary"] == []
    assert len(audit["personas"]) == 23


def test_scenario_ids_are_stable_machine_identifiers() -> None:
    assert all(
        re.fullmatch(r"[a-z0-9_.-]+", scenario.id)
        for scenario in CORE_SCENARIOS
    )


def test_no_effect_operations_are_explicit_failures() -> None:
    audit = build_corpus_audit()
    gaps = audit["noEffectGaps"]

    assert gaps["affectedScenarioCount"] == 304
    assert gaps["actionOccurrenceCount"] == 346
    assert audit["unclassifiedSuccessfulNoEffects"] == []
    assert audit["executionErrors"] == []
    assert all(
        occurrence["result"].get("ok") is False
        and occurrence["result"].get("noEffect") is True
        and occurrence["result"].get("status")
        in {"unsupported", "confirmation_required"}
        for occurrence in gaps["occurrences"]
    )


def test_modeled_no_mutation_exemptions_are_separate() -> None:
    audit = build_corpus_audit()
    exemptions = audit["modeledNoMutationOccurrences"]

    assert exemptions
    assert all(
        occurrence["operation"] in audit["modeledNoMutationOperations"]
        for occurrence in exemptions
    )
    assert all(
        occurrence["result"].get("noEffect") is not True
        and occurrence["result"].get("noop") is not True
        for occurrence in exemptions
    )
