from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import audit_asimov1_released_models as audit  # noqa: E402


def test_released_model_audit_records_freshness_and_sources(monkeypatch) -> None:
    monkeypatch.setattr(
        audit,
        "collect_asimov1_source_inventory",
        lambda: {
            "ok": True,
            "released_policy_artifacts": [],
            "expected_remote": "https://github.com/asimovinc/asimov-1.git",
        },
    )
    now = dt.datetime(2026, 5, 21, 12, 34, 56, tzinfo=dt.UTC)

    report = audit.audit_released_models(check_github_releases=False, checked_at=now)

    assert report["ok"] is True
    assert report["checked_at_utc"] == "2026-05-21T12:34:56+00:00"
    assert report["check_github_releases"] is False
    assert "asimovinc/asimov-1" in report["audited_repositories"]
    assert "https://manual.asimov.inc/v1" in report["sources"]
    assert "https://manual.asimov.inc/v1/quickstart" in report["sources"]
    assert "https://manual.asimov.inc/v0/locomotion/reinforcement-learning-reward-design" in report["sources"]
    assert "https://docs.menlo.ai/asimov/v1/locomotion/reinforcement-learning-for-locomotion" in report["sources"]
    claim_sources = {claim["source"] for claim in report["public_policy_claims"]}
    assert "https://github.com/asimovinc/asimov-v1" in claim_sources
    assert "https://manual.asimov.inc/v1/quickstart" in claim_sources
    assert report["public_policy_claims"]


def test_released_model_audit_reports_found_local_model_artifact(monkeypatch) -> None:
    monkeypatch.setattr(
        audit,
        "collect_asimov1_source_inventory",
        lambda: {
            "ok": True,
            "released_policy_artifacts": ["models/walk_policy.onnx"],
        },
    )

    report = audit.audit_released_models(check_github_releases=False)

    assert report["ok"] is False
    assert report["found_released_policy_or_model"] is True
    assert report["model_artifacts"] == [
        {
            "repo": "pinned_checkout",
            "source": "submodule_checkout",
            "path": "models/walk_policy.onnx",
            "url": None,
            "size": None,
        }
    ]


def test_released_model_audit_discovers_org_repositories(monkeypatch) -> None:
    monkeypatch.setattr(
        audit,
        "collect_asimov1_source_inventory",
        lambda: {
            "ok": True,
            "released_policy_artifacts": [],
            "expected_remote": "https://github.com/asimovinc/asimov-1.git",
        },
    )
    monkeypatch.setattr(
        audit,
        "_discover_asimov_org_repos",
        lambda: {
            "checked": True,
            "ok": True,
            "repos": ["asimovinc/asimov-new-policy"],
            "repo_metadata": [],
        },
    )

    audited_repos: list[list[str]] = []

    def fake_audit_github(repos: list[str]):
        audited_repos.append(list(repos))
        return (
            {"checked": True, "token_used": False, "repos": []},
            {
                "checked": True,
                "token_used": False,
                "repos": [
                    {
                        "repo": "asimovinc/asimov-new-policy",
                        "ok": True,
                        "artifacts": [
                            {
                                "repo": "asimovinc/asimov-new-policy",
                                "source": "repository_tree",
                                "path": "checkpoints/walk_policy.onnx",
                                "url": "https://example.invalid/walk_policy.onnx",
                                "size": 123,
                            }
                        ],
                    }
                ],
            },
            [
                {
                    "repo": "asimovinc/asimov-new-policy",
                    "source": "repository_tree",
                    "path": "checkpoints/walk_policy.onnx",
                    "url": "https://example.invalid/walk_policy.onnx",
                    "size": 123,
                }
            ],
        )

    monkeypatch.setattr(audit, "_audit_github", fake_audit_github)

    report = audit.audit_released_models(check_github_releases=True)

    assert "asimovinc/asimov-new-policy" in report["audited_repositories"]
    assert "asimovinc/asimov-new-policy" in audited_repos[0]
    assert report["found_released_policy_or_model"] is True
    assert report["ok"] is False
