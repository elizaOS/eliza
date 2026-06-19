"""Artifact guards for the Step 2 associative promotion boundary."""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Any, cast

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DOC_PATH = REPO_ROOT / "docs" / "research" / "step2_associative_evidence_gate.md"
ASSOCIATIVE_HYBRID_PATH = (
    REPO_ROOT
    / "outputs"
    / "step2_new_directions"
    / "associative_external_hybrid_900_10seed"
    / "results.json"
)
SPARSE_KV_FOCUS_PATH = (
    REPO_ROOT
    / "outputs"
    / "step2_new_directions"
    / "sparse_kv_associative_probe_900_30seed_focus"
    / "results.json"
)
OPMNIST_PATH = (
    REPO_ROOT
    / "outputs"
    / "step2_canonical"
    / "opmnist_true_mnist_40block_mse_results.json"
)


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        pytest.skip(f"{path.name} not present — run the associative benchmark to produce it")
    with path.open(encoding="utf-8") as f:
        return cast(dict[str, Any], json.load(f))


def _records_by_key(
    records: Iterable[dict[str, Any]],
) -> dict[tuple[str | None, int, str], dict[str, float]]:
    by_key: dict[tuple[str | None, int, str], dict[str, float]] = {}
    for record in records:
        key = (
            cast(str | None, record.get("benchmark")),
            int(record["seed"]),
            str(record["method"]),
        )
        by_key[key] = cast(dict[str, float], record["summary"])
    return by_key


def _assert_not_claimed(payload: dict[str, Any], *keys: str) -> None:
    for key in keys:
        assert payload.get(key) is not True


def test_guard_doc_keeps_claim_level_machine_readable() -> None:
    text = DOC_PATH.read_text(encoding="utf-8")

    required_markers = (
        "`associative_core_promotion`: `implementation_closure`",
        "`formal_universality_supported`: `false`",
        "`published_scale_opmnist_supported`: `false`",
        "`associative_positive_artifact`: "
        "`outputs/step2_new_directions/associative_external_hybrid_900_10seed/results.json`",
        "`opmnist_status_artifact`: "
        "`outputs/step2_canonical/opmnist_true_mnist_40block_mse_results.json`",
    )
    for marker in required_markers:
        assert marker in text

    overclaims = (
        "published-scale OPMNIST is closed",
        "formal universality is closed",
        "global theorem of universal representation learning is established",
    )
    lowered = text.lower()
    for phrase in overclaims:
        assert phrase.lower() not in lowered


def test_associative_hybrid_artifact_is_positive_implementation_evidence() -> None:
    results = _load_json(ASSOCIATIVE_HYBRID_PATH)
    config = results["config"]

    assert config["steps"] == 900
    assert config["seeds"] == 10
    assert config["run_ffn"] is True
    assert set(config["benchmarks"]) == {
        "block_shift_markov",
        "delayed_copy",
        "sparse_kv_recall",
        "local_text_motif",
    }
    assert any(
        variant["name"] == "hybrid_token_suffix_norm4"
        for variant in config["variants"]
    )

    by_key = _records_by_key(cast(list[dict[str, Any]], results["records"]))
    for benchmark in cast(list[str], config["benchmarks"]):
        diffs: list[float] = []
        accuracy_diffs: list[float] = []
        for seed in range(int(config["seeds"])):
            baseline = by_key[(benchmark, seed, "baseline_ffn_transformer")]
            associative = by_key[(benchmark, seed, "hybrid_token_suffix_norm4")]
            diffs.append(float(baseline["eval_nll"]) - float(associative["eval_nll"]))
            accuracy_diffs.append(
                float(associative["eval_accuracy"]) - float(baseline["eval_accuracy"])
            )

        assert all(diff > 0.0 for diff in diffs), benchmark
        assert sum(diff > 0.0 for diff in diffs) == int(config["seeds"])
        assert sum(diffs) / len(diffs) > 0.0
        assert sum(accuracy_diffs) / len(accuracy_diffs) > 0.0

    _assert_not_claimed(
        results,
        "published_scale_external_claim_supported",
        "formal_universality_supported",
    )


def test_sparse_kv_focus_artifact_is_mechanism_evidence_not_universality() -> None:
    results = _load_json(SPARSE_KV_FOCUS_PATH)
    config = results["config"]
    benchmark_payload = results["benchmark"]
    benchmark = benchmark_payload[0] if isinstance(benchmark_payload, list) else benchmark_payload

    assert benchmark["name"] == "sparse_kv_recall"
    assert config["seeds"] == 30
    assert config["steps"] == 900
    assert any(
        variant["name"] == "suffix_pair_utility_norm4"
        for variant in config["variants"]
    )

    by_key = _records_by_key(cast(list[dict[str, Any]], results["records"]))
    diffs: list[float] = []
    row_benchmark = cast(str | None, results["records"][0].get("benchmark"))
    for seed in range(int(config["seeds"])):
        baseline = by_key[(row_benchmark, seed, "baseline_ffn_transformer")]
        associative = by_key[(row_benchmark, seed, "suffix_pair_utility_norm4")]
        diffs.append(float(baseline["eval_nll"]) - float(associative["eval_nll"]))

    assert all(diff > 0.0 for diff in diffs)
    _assert_not_claimed(results, "formal_universality_supported")


def test_opmnist_and_formal_universality_remain_open_boundaries() -> None:
    opmnist = _load_json(OPMNIST_PATH)
    status = opmnist["status"]
    dataset = opmnist["datasets"]["permuted_mnist_like"]

    assert status["matches_dohare_opmnist_core_protocol"] is True
    assert status["opmnist_completed_full_60000_task_blocks"] == 40
    assert dataset["n_permutations"] == 800
    assert status["matches_dohare_opmnist_published_task_count"] is False
    assert status["published_scale_external_claim_supported"] is False

    text = DOC_PATH.read_text(encoding="utf-8")
    assert "`formal_universality_required_artifact`: " in text
    assert "`opmnist_published_scale_required_artifact`: " in text
