"""Check filesystem preservation and explicit legacy-store rejection before dispatch."""
from pathlib import Path
import pytest
from benchmarks.orchestrator.runner import run_benchmarks
from benchmarks.orchestrator.types import RunRequest
from benchmarks.orchestrator.result_store import LegacyResultStoreError, result_store_root


def test_fresh_store_is_repository_local_without_creating_directories(tmp_path: Path) -> None:
    target = result_store_root(tmp_path)
    assert target == tmp_path / "benchmark_results"
    assert not target.exists()


@pytest.mark.parametrize("canonical_exists", [False, True])
def test_legacy_results_are_preserved_and_never_implicitly_combined(tmp_path: Path, canonical_exists: bool) -> None:
    legacy = tmp_path / "suites" / "benchmark_results"
    legacy.mkdir(parents=True)
    saved = legacy / "result.json"
    saved.write_text('{"score": 0.75}\n')
    canonical = tmp_path / "benchmark_results"
    if canonical_exists:
        canonical.mkdir()
        (canonical / "result.json").write_text('{"score": 0.5}\n')
    with pytest.raises(LegacyResultStoreError, match="Archive or migrate"):
        run_benchmarks(workspace_root=tmp_path,
                       request=RunRequest(benchmarks=("unused",), agent="eliza",
                                          provider="mock", model="mock", extra_config={}),
                       execution_repo_meta={})
    assert saved.read_text() == '{"score": 0.75}\n'
    assert canonical.exists() is canonical_exists
    if canonical_exists:
        assert (canonical / "result.json").read_text() == '{"score": 0.5}\n'
