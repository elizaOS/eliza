"""Documentation-boundary tests for Step 2 associative-memory theory."""

from __future__ import annotations

from pathlib import Path

DOC_PATH = Path("docs/research/step2_associative_memory_theory.md")


def _read_doc() -> str:
    assert DOC_PATH.exists()
    return DOC_PATH.read_text(encoding="utf-8")


def _between(text: str, start_marker: str, end_marker: str) -> str:
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    return text[start:end]


def _squash(text: str) -> str:
    return " ".join(text.split())


def test_theory_note_declares_required_sections() -> None:
    """The note exposes the requested theorem, counterexample, and boundaries."""
    text = _read_doc()

    required_sections = [
        "# Step 2 Associative Memory Theory Boundary",
        "## Claim Ledger",
        "## Assumptions",
        "## Theorem 1: Conditional Finite Key/Value Binding Learning",
        (
            "## Counterexample 1: Finite Associative Memory Is Not Arbitrary "
            "Recursive Continuous Feature Discovery"
        ),
        "## Evidence Boundary For The Implementation",
        "## Non-Claim Language",
    ]

    for section in required_sections:
        assert section in text


def test_positive_theorem_states_all_assumption_families() -> None:
    """The positive claim is conditional on the requested assumption families."""
    text = _read_doc()
    assumptions = _between(text, "## Assumptions", "## Theorem 1")

    required_terms = [
        "A1. Recurrence",
        "A2. Separability and collision control",
        "A3. Capacity and retention",
        "A4. Bounded update and bounded loss",
        "A5. Bounded drift",
        "A6. Temporal causality",
        "prediction-before-write",
        "maximum inter-arrival gap",
        "incompatible value",
        "replacement policy",
    ]

    for term in required_terms:
        assert term in assumptions


def test_positive_theorem_is_finite_binding_not_universal_language() -> None:
    """The theorem is phrased as finite key/value learning with residual terms."""
    text = _read_doc()
    theorem = _squash(_between(text, "## Theorem 1", "## Counterexample 1"))

    required_terms = [
        "finite binding set",
        "finite associative memory",
        "M",
        "n_i(t)",
        "e_i(t)",
        "1 - beta_i",
        "collision-free",
        "no-eviction",
        "warmup cost",
        "repeated finite key/value bindings",
    ]

    for term in required_terms:
        assert term in theorem

    assert "not arbitrary recursive feature discovery" not in theorem.lower()


def test_counterexample_rejects_arbitrary_recursive_continuous_claim() -> None:
    """The negative section includes the finite-key aliasing lower bound."""
    text = _read_doc()
    counterexample = _squash(
        _between(text, "## Counterexample 1", "## Evidence Boundary")
    )

    required_terms = [
        "X = [0, 1]",
        "same active key abstraction",
        "continuous target function",
        "f(a) = 0",
        "f(b) = 1",
        "a, b, a, b",
        "1 / 4",
        "identifiability and capacity failure",
        "rejects the phrase",
        "finite associative memory is arbitrary recursive continuous feature discovery",
    ]

    for term in required_terms:
        assert term in counterexample


def test_non_claim_language_blocks_overbroad_claim() -> None:
    """Every occurrence of the overbroad phrase is surrounded by limiting language."""
    text = _read_doc()
    phrase = "arbitrary recursive continuous feature discovery"
    markers = [
        "false",
        "not",
        "reject",
        "non-claim",
        "does not prove",
        "overbroad",
    ]
    starts = [
        index
        for index in range(len(text))
        if text.lower().startswith(phrase, index)
    ]

    assert starts
    for start in starts:
        context = text[max(0, start - 180) : start + len(phrase) + 180].lower()
        assert any(marker in context for marker in markers)


def test_counterexample_loss_lower_bound_is_consistent() -> None:
    """The documented aliasing lower bound is the exact best constant predictor loss."""
    candidate_predictions = [0.0, 0.25, 0.5, 0.75, 1.0]
    losses = [
        (prediction**2 + (prediction - 1.0) ** 2) / 2.0
        for prediction in candidate_predictions
    ]

    assert min(losses) == 0.25
