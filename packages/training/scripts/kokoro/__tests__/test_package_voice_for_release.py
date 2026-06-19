"""Tests for Kokoro release packaging."""

from __future__ import annotations

import json
from pathlib import Path

import package_voice_for_release  # type: ignore  # noqa: E402


def test_package_voice_only_release_synthesizes_canonical_fragment(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "voice.bin").write_bytes(b"\x00" * 522_240)
    (run_dir / "eval.json").write_text(
        json.dumps(
            {
                "kind": "kokoro-eval-report",
                "metrics": {
                    "utmos": 4.0,
                    "wer": 0.04,
                    "speaker_similarity": 0.78,
                    "rtf": 12.5,
                },
                "gateResult": {"passed": True},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    rc = package_voice_for_release.main(
        [
            "--run-dir",
            str(run_dir),
            "--release-dir",
            str(tmp_path / "release"),
            "--voice-name",
            "af_same",
            "--voice-display-name",
            "Same",
        ]
    )
    assert rc == 0

    release = tmp_path / "release" / "af_same"
    assert (release / "voice.bin").is_file()
    assert not (release / "kokoro.onnx").exists()
    fragment = json.loads((release / "manifest-fragment.json").read_text())
    assert fragment["voice"]["hfPath"] == "voice/kokoro/voices/af_same.bin"
    assert fragment["voice"]["file"] == "af_same.bin"
    assert fragment["engine"]["onnxPath"] is None
    assert fragment["artifacts"] == [
        {"role": "voice-preset", "path": "voice/kokoro/voices/af_same.bin"}
    ]
