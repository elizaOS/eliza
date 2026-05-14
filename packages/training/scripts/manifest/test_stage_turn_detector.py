"""Smoke tests for the Voice Wave 2 turn-detector staging step.

These exercise the structural surface of `stage_turn_detector` and the
new `--turn-license` / `--skip-turn-detector` CLI flags without making
network calls. The actual ONNX byte transfer is mocked by patching
`copy_hf_file`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

import pytest

# Allow `from scripts.manifest import …` even when the test is invoked
# without the package install (mirrors sibling test scaffolding).
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.manifest import stage_eliza1_bundle_assets as stage  # noqa: E402


@pytest.fixture(autouse=True)
def _patch_copy(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Replace `copy_hf_file` with a recording stub."""
    calls: list[dict[str, Any]] = []

    def _fake_copy(
        *,
        repo_id: str,
        revision: str | None,
        remote_path: str,
        destination: Path,
        link_mode: str,
        dry_run: bool,
    ) -> dict[str, Any]:
        record = {
            "repo": repo_id,
            "revision": revision,
            "remotePath": remote_path,
            "path": str(destination),
            "linkMode": link_mode,
            "dryRun": dry_run,
        }
        calls.append(record)
        return record

    monkeypatch.setattr(stage, "copy_hf_file", _fake_copy)
    return calls


def test_stage_turn_detector_livekit_en_for_small_tiers(
    tmp_path: Path,
    _patch_copy: list[dict[str, Any]],
) -> None:
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    report = stage.stage_turn_detector(
        tier="2b",
        license="livekit",
        bundle_dir=bundle_dir,
        link_mode="copy",
        dry_run=True,
    )
    assert report["license"] == "livekit"
    assert report["repo"] == "livekit/turn-detector"
    assert report["revision"] == "v1.2.2-en"
    # 3 files: ONNX, tokenizer, languages.json.
    assert len(report["files"]) == 3
    assert report["licenseId"].startswith("livekit-model-license")
    remote_paths = sorted(c["remotePath"] for c in _patch_copy)
    assert remote_paths == sorted(
        [
            stage.TURN_DETECTOR_LIVEKIT_ONNX_REMOTE,
            stage.TURN_DETECTOR_TOKENIZER_REMOTE,
            stage.TURN_DETECTOR_LANGUAGES_REMOTE,
        ]
    )
    # All calls pinned to the EN revision.
    assert {c["revision"] for c in _patch_copy} == {"v1.2.2-en"}


def test_stage_turn_detector_livekit_intl_for_desktop_tiers(
    tmp_path: Path,
    _patch_copy: list[dict[str, Any]],
) -> None:
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    for tier in ("4b", "9b", "27b", "27b-256k", "27b-1m"):
        _patch_copy.clear()
        report = stage.stage_turn_detector(
            tier=tier,
            license="livekit",
            bundle_dir=bundle_dir,
            link_mode="copy",
            dry_run=True,
        )
        assert report["revision"] == "v0.4.1-intl", tier
        assert {c["revision"] for c in _patch_copy} == {"v0.4.1-intl"}


def test_stage_turn_detector_apache_fallback(
    tmp_path: Path,
    _patch_copy: list[dict[str, Any]],
) -> None:
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    report = stage.stage_turn_detector(
        tier="4b",
        license="apache",
        bundle_dir=bundle_dir,
        link_mode="copy",
        dry_run=True,
    )
    assert report["license"] == "apache"
    assert report["repo"] == "latishab/turnsense"
    # No revision pinning on the Turnsense path.
    assert report["revision"] is None
    assert report["licenseId"] == "apache-2.0"
    # Only ONNX + tokenizer (no languages.json on Turnsense).
    assert len(report["files"]) == 2
    remote_paths = sorted(c["remotePath"] for c in _patch_copy)
    assert remote_paths == sorted(
        [
            stage.TURN_DETECTOR_TURNSENSE_ONNX_REMOTE,
            stage.TURN_DETECTOR_TOKENIZER_REMOTE,
        ]
    )


def test_stage_turn_detector_rejects_unknown_license(tmp_path: Path) -> None:
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    with pytest.raises(ValueError, match="must be one of"):
        stage.stage_turn_detector(
            tier="4b",
            license="bsd",  # not a real choice
            bundle_dir=bundle_dir,
            link_mode="copy",
            dry_run=True,
        )


def test_slot_for_bundle_path_turn_onnx_only() -> None:
    # The slot resolver only counts the ONNX as a manifest-files entry —
    # tokenizer.json + languages.json ride along on disk as sidecars.
    assert (
        stage._slot_for_bundle_path("turn/model_q8.onnx") == "turn"
    )
    assert stage._slot_for_bundle_path("turn/tokenizer.json") is None
    assert stage._slot_for_bundle_path("turn/languages.json") is None


def test_cli_args_default_to_livekit_and_run_turn_detector() -> None:
    args = stage.parse_args(
        ["--tier", "4b", "--bundle-dir", "/tmp/whatever"],
    )
    assert args.turn_license == "livekit"
    assert args.skip_turn_detector is False


def test_cli_args_allow_apache_override() -> None:
    args = stage.parse_args(
        [
            "--tier",
            "4b",
            "--bundle-dir",
            "/tmp/whatever",
            "--turn-license",
            "apache",
        ],
    )
    assert args.turn_license == "apache"


def test_cli_args_allow_skip_turn_detector() -> None:
    args = stage.parse_args(
        [
            "--tier",
            "4b",
            "--bundle-dir",
            "/tmp/whatever",
            "--skip-turn-detector",
        ],
    )
    assert args.skip_turn_detector is True


def test_cli_rejects_unknown_license() -> None:
    with pytest.raises(SystemExit):
        stage.parse_args(
            [
                "--tier",
                "4b",
                "--bundle-dir",
                "/tmp/whatever",
                "--turn-license",
                "bsd",
            ],
        )
