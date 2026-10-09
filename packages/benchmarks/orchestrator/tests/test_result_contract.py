"""Scored runs accept declared current-run artifacts and finite scores only."""

from pathlib import Path

import pytest

from benchmarks.bench_cli_types import expect_float
from benchmarks.orchestrator.adapters import _make_extra_adapter
from benchmarks.orchestrator.scoring import RegistryScoreExtractor
from benchmarks.orchestrator.types import ScoreSummary


@pytest.mark.parametrize("score", [float("nan"), float("inf"), -float("inf"), True])
def test_nonfinite_scores_rejected(score):
    with pytest.raises(ValueError):
        ScoreSummary(score, "ratio", True)
    with pytest.raises(ValueError):
        expect_float(score, ctx="test score")


def test_no_arbitrary_or_checkout_result_fallback(tmp_path: Path):
    checkout = tmp_path / "checkout"
    output = tmp_path / "run"
    checkout.mkdir()
    output.mkdir()
    (checkout / "result.json").write_text('{"score": 1}')
    (output / "diagnostics.json").write_text('{"score": 1}')
    adapter = _make_extra_adapter(
        adapter_id="test",
        directory="test",
        description="test",
        cwd=str(checkout),
        command_builder=lambda *_: [],
        result_patterns=["result.json"],
        score_extractor=lambda _: ScoreSummary(0.1, "ratio", True),
    )
    with pytest.raises(FileNotFoundError, match="declared result"):
        adapter.result_locator(None, adapter, output)
    (output / "result.json").write_text('{"diagnostic":{"score": 0.99}, "score":0.1}')
    assert adapter.result_locator(None, adapter, output) == output / "result.json"


def test_unknown_workload_has_no_guessing_scorer():
    extractor = RegistryScoreExtractor(Path(__file__).resolve().parents[2])
    with pytest.raises(KeyError, match="No declared scorer"):
        extractor.for_benchmark("unregistered")


def test_provenance_uses_observed_artifact_not_requested_revision(tmp_path: Path):
    import json
    from benchmarks.orchestrator.runner import _build_reproducibility_metadata
    from benchmarks.orchestrator.types import RunRequest

    request = RunRequest(
        ("test",), "eliza", "test", "test", {"dataset_revision": "requested"}
    )
    artifact = tmp_path / "result.json"
    artifact.write_text(
        json.dumps(
            {"metadata": {"dataset_revision": "observed", "workload_sha256": "digest"}}
        )
    )
    observed = _build_reproducibility_metadata(
        workspace_root=tmp_path, request=request, repo_meta={}, result_path=artifact
    )
    assert observed["dataset_revision"] == "observed"
    assert observed["dataset_identity_known"] is True
    missing = _build_reproducibility_metadata(
        workspace_root=tmp_path, request=request, repo_meta={}
    )
    assert missing["dataset_revision"] is None
    assert missing["dataset_identity_known"] is False
    assert missing["extra_config"]["dataset_revision"] == "requested"


def test_matrix_does_not_score_unrelated_json(tmp_path: Path):
    from benchmarks.orchestrator.code_agent_execution import find_latest_result

    (tmp_path / "telemetry.json").write_text('{"score": 1}')
    assert find_latest_result(tmp_path) is None
    artifact = tmp_path / "terminal-bench-results.json"
    artifact.write_text('{"score": 0.2}')
    assert find_latest_result(tmp_path) == artifact
