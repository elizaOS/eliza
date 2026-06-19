"""Text-contract tests for the Step 2 UPGD recursive-feature theory note."""

from __future__ import annotations

import re
from pathlib import Path

DOC_PATH = (
    Path(__file__).resolve().parents[1]
    / "docs"
    / "research"
    / "step2_upgd_recursive_feature_discovery_theory.md"
)

ASSUMPTIONS = {
    "A1": "Declared/generated class",
    "A2": "Evidence/excitation",
    "A3": "Bounded losses and updates",
    "A4": "Capacity budget",
    "A5": "Drift model",
    "A6": "Causal information",
    "A7": "Selector/readout guarantee",
    "A8": "Target-structure semantics",
}

THEOREM_MARKERS = (
    "THEOREM N1: No arbitrary recursive feature discovery without declared assumptions",
    "THEOREM P1: Conditional finite/expanding generated-class UPGD selection",
)

COUNTEREXAMPLE_MARKERS = {
    "COUNTEREXAMPLE C1: Missing generated class": "A1",
    "COUNTEREXAMPLE C2: No evidence or excitation": "A2",
    "COUNTEREXAMPLE C3: Unbounded losses": "A3",
    "COUNTEREXAMPLE C4: Finite capacity": "A4",
    "COUNTEREXAMPLE C5: Arbitrary drift": "A5",
}

NON_THEOREM_MARKER = "NON-THEOREM MARKER: Arbitrary universality is not claimed"


def _doc_text() -> str:
    return DOC_PATH.read_text(encoding="utf-8")


def _normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _section(text: str, marker: str) -> str:
    heading = f"## {marker}"
    start = text.index(heading)
    next_heading = text.find("\n## ", start + len(heading))
    if next_heading == -1:
        return text[start:]
    return text[start:next_heading]


def _declared_assumptions(text: str) -> dict[str, str]:
    matches = re.findall(r"^- \*\*(A\d+): ([^.]+)\.\*\*", text, flags=re.MULTILINE)
    return dict(matches)


def _assumption_refs(text: str) -> set[str]:
    return set(re.findall(r"\bA\d+\b", text))


def test_doc_declares_exact_assumption_registry() -> None:
    text = _doc_text()

    assert _declared_assumptions(text) == ASSUMPTIONS


def test_doc_contains_exact_theorem_and_counterexample_markers_once() -> None:
    text = _doc_text()

    for marker in (*THEOREM_MARKERS, *COUNTEREXAMPLE_MARKERS, NON_THEOREM_MARKER):
        assert text.count(f"## {marker}") == 1


def test_all_referenced_assumptions_are_explicitly_declared() -> None:
    text = _doc_text()
    declared = set(_declared_assumptions(text))
    refs = _assumption_refs(text)

    assert refs <= declared
    assert set(ASSUMPTIONS) <= refs


def test_negative_and_positive_theorems_list_all_required_assumptions() -> None:
    text = _doc_text()

    for marker in THEOREM_MARKERS:
        block = _section(text, marker)
        assert "**Assumptions used:**" in block
        assert _assumption_refs(block) == set(ASSUMPTIONS)


def test_counterexamples_identify_which_assumption_is_omitted() -> None:
    text = _doc_text()

    for marker, omitted in COUNTEREXAMPLE_MARKERS.items():
        block = _section(text, marker)
        assert f"**Omitted assumption:** {omitted}." in block
        assert "**Assumptions held for the construction:**" in block
        assert omitted in _assumption_refs(block)
        assert _assumption_refs(block) <= set(ASSUMPTIONS)


def test_requested_boundary_assumptions_are_named_in_plain_language() -> None:
    text = _normalized(_doc_text()).lower()

    for phrase in (
        "declared/generated class",
        "evidence/excitation",
        "bounded losses",
        "capacity budget",
        "drift model",
    ):
        assert phrase in text


def test_note_rejects_arbitrary_universality_instead_of_proving_it() -> None:
    text = _normalized(_doc_text())
    non_theorem = _normalized(_section(_doc_text(), NON_THEOREM_MARKER))

    assert "It intentionally does not claim arbitrary universality." in text
    assert (
        "This document does not prove that bare UPGD discovers arbitrary "
        "recursive features."
    ) in non_theorem
    assert "approximation, evidence, bounded-loss, capacity" in non_theorem
