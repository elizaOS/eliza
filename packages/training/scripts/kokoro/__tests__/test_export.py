"""Drive `export_to_onnx.py --synthetic-smoke` and assert manifest fragment shape.

The fragment is what `eliza1_platform_plan.py` / the publish flow stitches
into the per-tier bundle. Shape stability is a hard contract — any change
must be reflected in the catalog merge step.
"""

from __future__ import annotations

import json
from pathlib import Path

import export_to_onnx  # type: ignore  # noqa: E402


def test_export_synthetic_smoke_emits_fragment(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    rc = export_to_onnx.main(
        [
            "--out-dir",
            str(out_dir),
            "--voice-name",
            "test_voice",
            "--voice-display-name",
            "Test Voice",
            "--voice-lang",
            "a",
            "--voice-tags",
            "custom,test",
            "--synthetic-smoke",
        ]
    )
    assert rc == 0, f"export exit code {rc}"

    onnx_path = out_dir / "kokoro.onnx"
    fragment_path = out_dir / "manifest-fragment.json"
    assert onnx_path.exists(), "kokoro.onnx missing"
    assert onnx_path.stat().st_size > 0, "kokoro.onnx is empty"
    assert fragment_path.exists(), "manifest-fragment.json missing"

    fragment = json.loads(fragment_path.read_text())
    assert fragment["schemaVersion"] == 1
    assert fragment["kind"] == "eliza-1-kokoro-voice-fragment"
    assert fragment["synthetic"] is True

    voice = fragment["voice"]
    assert voice["id"] == "test_voice"
    assert voice["displayName"] == "Test Voice"
    assert voice["lang"] == "a"
    assert voice["dim"] == 256
    assert set(voice["tags"]) == {"custom", "test"}

    engine = fragment["engine"]
    assert engine["kind"] == "kokoro"
    assert engine["baseModel"] == "hexgrad/Kokoro-82M"
    assert engine["onnxPath"] == "tts/kokoro.onnx"

    # The artifacts list is what the publish step copies into the per-tier
    # bundle under `tts/`. Both entries must be present even if voice-bin
    # is null (the package step fills it in from extract_voice_embedding).
    roles = {entry["role"] for entry in fragment["artifacts"]}
    assert roles == {"voice-onnx", "voice-preset"}

    # The integration block carries the runtime hand-off — the publish
    # reviewer follows these paths to merge the voice into voice-presets.ts.
    integration = fragment["integration"]
    assert "runtimeBackendDir" in integration
    assert "voicePresetFormat" in integration
    assert "catalogTable" in integration


def test_export_default_tags(tmp_path: Path) -> None:
    """No explicit --voice-tags falls through to the default."""
    out_dir = tmp_path / "out"
    rc = export_to_onnx.main(["--out-dir", str(out_dir), "--synthetic-smoke"])
    assert rc == 0
    fragment = json.loads((out_dir / "manifest-fragment.json").read_text())
    assert set(fragment["voice"]["tags"]) == {"custom", "eliza-1"}
