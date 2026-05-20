from __future__ import annotations

import json
from pathlib import Path

from scripts.manifest.dflash_tuning_report import build_report


def _write(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, (dict, list)):
        path.write_text(json.dumps(data) + "\n", encoding="utf-8")
    else:
        path.write_text(str(data), encoding="utf-8")


def test_build_report_keeps_runtime_smoke_separate_from_speedup_gate(tmp_path: Path) -> None:
    bundle = tmp_path / "eliza-1-0_8b.bundle"
    _write(
        bundle / "dflash" / "target-meta.json",
        {
            "tier": "0_8b",
            "publishEligible": False,
            "targetText": {"path": "text/eliza-1-0_8b-256k.gguf"},
            "drafter": {"matchesTargetCheckpoint": True},
            "acceptanceRollout": {"gate": 0.4},
        },
    )
    _write(
        bundle / "dflash" / "runtime-smoke-native.json",
        {
            "metadataStatus": "metadata_loadable",
            "metadataFailures": [],
            "runtime": [
                {
                    "dflash": {
                        "drafted": 1,
                        "accepted": 1,
                        "acceptanceRate": 1.0,
                        "draftingActive": True,
                    }
                }
            ],
        },
    )
    _write(
        bundle / "evals" / "dflash-native-bench.json",
        {"status": "fail", "failure": "runtime produced zero drafted tokens"},
    )
    _write(
        bundle / "evals" / "dflash-accept.json",
        {"status": "blocked", "passed": False},
    )

    report = build_report(bundle)

    assert report["status"] == "optimization-blocked"
    assert report["runtimeSmoke"]["accepted"] == 1
    assert "native release bench did not prove acceptance plus speedup > 1.0" in report["blockers"]


def test_build_report_marks_publishable_only_with_speedup_and_gate(tmp_path: Path) -> None:
    bundle = tmp_path / "eliza-1-4b.bundle"
    _write(
        bundle / "dflash" / "target-meta.json",
        {
            "tier": "4b",
            "publishEligible": True,
            "targetText": {"path": "text/eliza-1-4b-256k.gguf"},
            "drafter": {"matchesTargetCheckpoint": True},
            "acceptanceRollout": {"gate": 0.4},
        },
    )
    _write(
        bundle / "dflash" / "runtime-smoke-native.json",
        {
            "metadataStatus": "metadata_loadable",
            "metadataFailures": [],
            "runtime": [
                {
                    "dflash": {
                        "drafted": 8,
                        "accepted": 6,
                        "acceptanceRate": 0.75,
                        "draftingActive": True,
                    }
                }
            ],
        },
    )
    _write(
        bundle / "evals" / "dflash-native-bench.json",
        {
            "status": "pass",
            "acceptanceRate": 0.75,
            "speedup": 1.2,
            "drafted": 8,
            "accepted": 6,
        },
    )
    _write(bundle / "evals" / "dflash-accept.json", {"status": "ok", "passed": True})

    report = build_report(bundle)

    assert report["status"] == "publishable"
    assert report["blockers"] == []
