"""Drive `push_voice_to_hf.py --dry-run` and verify the gate enforcement.

We never hit the live HF API in tests; the dry-run path exercises:
  - artifact presence check,
  - eval-gate enforcement (with + without override),
  - baseline-comparison gate when requested,
  - the model-card preamble + receipt JSON shape.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import push_voice_to_hf  # type: ignore  # noqa: E402


def _materialize_release(
    tmp_path: Path,
    *,
    voice_name: str = "af_same",
    gate_passed: bool = True,
    comparison: dict | None = None,
) -> Path:
    release = tmp_path / "release" / voice_name
    release.mkdir(parents=True, exist_ok=True)
    # voice.bin — a 1 KB chunk is enough; the sha256 check still triggers.
    (release / "voice.bin").write_bytes(b"\x00" * 1024)
    # kokoro.onnx — placeholder bytes.
    (release / "kokoro.onnx").write_bytes(b"ONNX-STUB")
    # voice-preset.json — minimal envelope.
    (release / "voice-preset.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "elz1-voice-preset",
                "voiceId": voice_name,
                "displayName": "Sam (Test)",
                "lang": "a",
                "tags": ["female", "sam", "research-only"],
                "dim": 256,
                "buckets": 510,
                "engine": {"kind": "kokoro", "baseModel": "hexgrad/Kokoro-82M"},
                "blob": {"filename": "voice.bin", "sha256": "stub", "sizeBytes": 1024},
                "synthetic": True,
                "generatedAt": "2026-05-14T00:00:00+00:00",
            }
        )
        + "\n"
    )
    # manifest-fragment.json — only the voice block is read downstream.
    (release / "manifest-fragment.json").write_text(
        json.dumps({"voice": {"id": voice_name}})
    )
    # eval.json — gate result toggled by the caller.
    eval_body = {
        "schemaVersion": 1,
        "kind": "kokoro-eval-report",
        "voiceName": voice_name,
        "metrics": {
            "utmos": 4.0,
            "wer": 0.04,
            "speaker_similarity": 0.78,
            "rtf": 12.5,
        },
        "gates": {
            "utmos_min": 3.8,
            "wer_max": 0.08,
            "speaker_similarity_min": 0.55,
            "rtf_min": 5.0,
        },
        "gateResult": {"passed": gate_passed, "perMetric": {}},
    }
    if comparison is not None:
        eval_body["comparison"] = comparison
    (release / "eval.json").write_text(json.dumps(eval_body, indent=2) + "\n")
    (release / "README.md").write_text("# stub release readme\n")
    return release


def test_dry_run_writes_receipt_and_passes_gate(tmp_path: Path) -> None:
    release = _materialize_release(tmp_path)
    receipt = tmp_path / "receipt.json"
    rc = push_voice_to_hf.main(
        [
            "--release-dir",
            str(release),
            "--hf-repo",
            "elizalabs/eliza-1-voice-kokoro-same-v01",
            "--dry-run",
            "--receipt",
            str(receipt),
        ]
    )
    assert rc == 0
    body = json.loads(receipt.read_text())
    assert body["kind"] == "kokoro-voice-hf-push-plan"
    assert body["dryRun"] is True
    assert body["private"] is True  # default per the sam license decision
    assert body["hfRepo"] == "elizalabs/eliza-1-voice-kokoro-same-v01"
    remotes = {entry["remote"] for entry in body["files"]}
    # README is rendered + included alongside the five required artifacts.
    assert remotes == {"README.md", "voice.bin", "kokoro.onnx", "voice-preset.json", "manifest-fragment.json", "eval.json"}


def test_failed_gate_blocks_publish(tmp_path: Path) -> None:
    release = _materialize_release(tmp_path, gate_passed=False)
    with pytest.raises(SystemExit):
        push_voice_to_hf.main(
            [
                "--release-dir",
                str(release),
                "--hf-repo",
                "elizalabs/eliza-1-voice-kokoro-same-v01",
                "--dry-run",
            ]
        )


def test_allow_gate_fail_with_justification(tmp_path: Path) -> None:
    release = _materialize_release(tmp_path, gate_passed=False)
    receipt = tmp_path / "receipt.json"
    rc = push_voice_to_hf.main(
        [
            "--release-dir",
            str(release),
            "--hf-repo",
            "elizalabs/eliza-1-voice-kokoro-same-v01",
            "--dry-run",
            "--allow-gate-fail",
            "tracked under issue #1234",
            "--receipt",
            str(receipt),
        ]
    )
    assert rc == 0
    # The receipt records what we would have uploaded; the override is in the README.
    body = json.loads(receipt.read_text())
    assert body["dryRun"] is True


def test_comparison_not_beat_blocks_publish(tmp_path: Path) -> None:
    release = _materialize_release(
        tmp_path,
        gate_passed=True,
        comparison={
            "baselinePath": "/tmp/baseline.json",
            "baselineVoiceName": "af_bella",
            "utmosDelta": 0.2,
            "werDelta": -0.01,
            "speakerSimDelta": 0.02,  # below the 0.05 threshold
            "rtfDelta": 0.0,
            "speakerSimBeatThreshold": 0.05,
            "beatsBaseline": False,
        },
    )
    with pytest.raises(SystemExit):
        push_voice_to_hf.main(
            [
                "--release-dir",
                str(release),
                "--hf-repo",
                "elizalabs/eliza-1-voice-kokoro-same-v01",
                "--dry-run",
            ]
        )


def test_public_flag_flips_private(tmp_path: Path) -> None:
    release = _materialize_release(tmp_path)
    receipt = tmp_path / "receipt.json"
    rc = push_voice_to_hf.main(
        [
            "--release-dir",
            str(release),
            "--hf-repo",
            "elizalabs/eliza-1-voice-kokoro-same-v01",
            "--dry-run",
            "--public",
            "--receipt",
            str(receipt),
        ]
    )
    assert rc == 0
    body = json.loads(receipt.read_text())
    assert body["private"] is False


def test_missing_artifact_fails_loud(tmp_path: Path) -> None:
    release = _materialize_release(tmp_path)
    (release / "voice.bin").unlink()
    with pytest.raises(SystemExit):
        push_voice_to_hf.main(
            [
                "--release-dir",
                str(release),
                "--hf-repo",
                "elizalabs/eliza-1-voice-kokoro-same-v01",
                "--dry-run",
            ]
        )
