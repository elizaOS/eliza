"""Tests for folding uploaded backend evidence into an HF manifest."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest.fold_hf_eliza1_backend_evidence import plan_fold  # noqa: E402


class FakeApi:
    def __init__(self, files: dict[str, object]) -> None:
        self.files = files

    def hf_hub_download(self, *, repo_id: str, filename: str, repo_type: str) -> str:
        assert repo_id == "repo"
        assert repo_type == "model"
        path = Path.cwd() / ".pytest-cache" / "fold-evidence" / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.files[filename]), encoding="utf-8")
        return str(path)


def _files(*, verify_status: str = "pass", dispatch_status: str = "pass", runtime_ready: bool = True):
    return {
        "bundles/2b/evals/cpu_reference.json": {
            "status": verify_status,
            "atCommit": "abc123",
        },
        "bundles/2b/evals/cpu_dispatch.json": {
            "status": dispatch_status,
            "runtimeReady": runtime_ready,
            "atCommit": "def456",
        },
        "bundles/2b/eliza-1.manifest.json": {
            "kernels": {
                "verifiedBackends": {
                    "cpu": {
                        "status": "fail",
                        "atCommit": "old",
                        "report": "evals/old.json",
                    }
                }
            }
        },
    }


def test_plan_fold_updates_only_selected_backend_status() -> None:
    plan = plan_fold(FakeApi(_files()), "repo", "2b", "cpu")

    assert plan["changed"] is True
    assert plan["old"] == {"status": "fail", "atCommit": "old", "report": "evals/old.json"}
    assert plan["new"] == {
        "status": "pass",
        "atCommit": "abc123",
        "report": "evals/cpu_reference.json",
    }
    assert plan["manifest"]["kernels"]["verifiedBackends"]["cpu"] == plan["new"]


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"verify_status": "fail"}, "cpu_reference.json status='fail'"),
        ({"dispatch_status": "fail"}, "cpu_dispatch.json status='fail'"),
        ({"runtime_ready": False}, "cpu_dispatch.json runtimeReady=False"),
    ],
)
def test_plan_fold_refuses_nonpassing_evidence(kwargs: dict[str, object], expected: str) -> None:
    with pytest.raises(SystemExit, match=expected):
        plan_fold(FakeApi(_files(**kwargs)), "repo", "2b", "cpu")


def test_plan_fold_rejects_unsupported_backend() -> None:
    with pytest.raises(SystemExit, match="cuda is not supported by tier 2b"):
        plan_fold(FakeApi(_files()), "repo", "2b", "cuda")
