#!/usr/bin/env python3
import json
import tempfile
from pathlib import Path
from unittest import mock

import check_pd_release_evidence


def test_manifest_diagnostic_maps_pd_blocker_classes() -> None:
    item = {
        "path": "docs/evidence/pd/example.yaml",
        "status": "draft_local_evidence",
        "release_use": "prohibited_until_signoff_replay",
        "release_blockers": [
            "DRC, LVS, STA, antenna, slew, and max-cap evidence must pass before release.",
        ],
    }

    diagnostic = check_pd_release_evidence.manifest_diagnostic(
        check_pd_release_evidence.ROOT / item["path"],
        item,
    )

    assert diagnostic["release_credit"] is False
    assert {"drc", "lvs", "antenna", "timing", "drv"} <= set(diagnostic["blocker_classes"])
    assert diagnostic["exact_artifact_path"] == item["path"]
    assert "python3 scripts/check_pd_signoff.py" in diagnostic["next_commands"]


def test_missing_manifests_are_blocked_not_release_credit() -> None:
    with tempfile.TemporaryDirectory(dir=check_pd_release_evidence.ROOT / "build") as tmp:
        evidence_dir = Path(tmp) / "empty-pd-evidence"
        report = Path(tmp) / "pd_release_evidence.json"
        evidence_dir.mkdir()

        with (
            mock.patch.object(check_pd_release_evidence, "EVIDENCE_DIR", evidence_dir),
            mock.patch.object(check_pd_release_evidence, "REPORT", report),
        ):
            rc = check_pd_release_evidence.main()

        payload = json.loads(report.read_text(encoding="utf-8"))
        assert rc == 2
        assert payload["status"] == "blocked"
        assert payload["release_credit"] is False
        assert payload["summary"]["release_credit"] is False
        assert payload["findings"][0]["code"] == "pd_release_evidence_missing_manifest"


def test_blocked_report_buckets_manifest_blockers_without_stale_fixed_bootrom() -> None:
    with tempfile.TemporaryDirectory(dir=check_pd_release_evidence.ROOT / "build") as tmp:
        evidence_dir = Path(tmp) / "pd-evidence"
        report = Path(tmp) / "pd_release_evidence.json"
        evidence_dir.mkdir()
        manifest = evidence_dir / "e1-soc-hard-macro-signoff-gate.yaml"
        manifest.write_text(
            "\n".join(
                [
                    "schema: eliza.pd_soc_hard_macro_signoff_gate.v1",
                    "status: draft_local_evidence",
                    "release_use: prohibited_until_external_review",
                    "release_blockers:",
                    "  - current bootrom string issue is now fixed; replay release run to final/",
                    "  - DRC, LVS, STA, and antenna evidence still needs external review",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        with (
            mock.patch.object(check_pd_release_evidence, "EVIDENCE_DIR", evidence_dir),
            mock.patch.object(check_pd_release_evidence, "REPORT", report),
            mock.patch.object(
                check_pd_release_evidence,
                "source_bootrom_string_blocker_resolved",
                return_value=True,
            ),
        ):
            rc = check_pd_release_evidence.main()

        payload = json.loads(report.read_text(encoding="utf-8"))
        bucket_counts = payload["summary"]["bucket_counts"]
        diagnostic = payload["findings"][0]["diagnostic"]
        assert rc == 2
        assert payload["status"] == "blocked"
        assert payload["release_credit"] is False
        assert "release_run_missing_final_artifacts" in bucket_counts
        assert "drc_lvs_antenna_signoff" in bucket_counts
        actions = {row["bucket"]: row for row in payload["summary"]["bucket_next_actions"]}
        assert actions["release_run_missing_final_artifacts"]["next_command"] == (
            "scripts/run_openlane.sh --release"
        )
        assert actions["drc_lvs_antenna_signoff"]["release_credit"] is False
        generation = payload["summary"]["repo_artifact_generation_summary"]
        assert generation["repo_generatable_now_count"] == 0
        assert generation["can_close_from_current_repo_count"] == 0
        assert generation["blocked_generation_count"] == sum(bucket_counts.values())
        by_bucket = {row["bucket"]: row for row in generation["buckets"]}
        assert by_bucket["release_run_missing_final_artifacts"]["repo_generatable_now"] is False
        assert (
            by_bucket["release_run_missing_final_artifacts"]["can_close_release_from_current_repo"]
            is False
        )
        assert (
            by_bucket["external_review_required"]["blocked_by"]["external_review_or_foundry_access"]
            is True
        )
        assert "stale_bootrom_string_frontend_blocker" not in bucket_counts
        assert diagnostic["blocker_records"][0]["release_credit"] is False


def main() -> int:
    test_manifest_diagnostic_maps_pd_blocker_classes()
    test_missing_manifests_are_blocked_not_release_credit()
    test_blocked_report_buckets_manifest_blockers_without_stale_fixed_bootrom()
    print("PD release evidence diagnostic tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
