"""Tests for the single-repo Eliza-1 model bundle publisher."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.publish import publish_eliza1_model_repo as P  # noqa: E402


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_bundle(root: Path, tier: str, *, voice_path: str = "tts/kokoro.gguf") -> Path:
    bundle = root / f"eliza-1-{tier}.bundle"
    text = b"gguf text"
    voice = b"voice"
    drafter = b"draft"
    for rel, blob in (
        (f"text/eliza-1-{tier}-32k.gguf", text),
        (voice_path, voice),
        (f"dflash/drafter-{tier}.gguf", drafter),
        ("cache/voice-preset-default.bin", b"cache"),
    ):
        path = bundle / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
    manifest = {
        "id": f"eliza-1-{tier}",
        "tier": tier,
        "version": "1.0.0",
        "files": {
            "text": [
                {
                    "path": f"text/eliza-1-{tier}-32k.gguf",
                    "sha256": _sha(text),
                    "ctx": 32768,
                }
            ],
            "voice": [{"path": voice_path, "sha256": _sha(voice)}],
            "dflash": [
                {"path": f"dflash/drafter-{tier}.gguf", "sha256": _sha(drafter)}
            ],
            "cache": [
                {
                    "path": "cache/voice-preset-default.bin",
                    "sha256": _sha(b"cache"),
                }
            ],
        },
    }
    (bundle / "eliza-1.manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return bundle


def test_plan_bundle_uses_single_repo_bundle_prefix(tmp_path: Path):
    _write_bundle(tmp_path, "0_8b")

    plan = P.plan_bundle(tmp_path, "0_8b")

    assert plan.uploadable is True
    assert plan.path_in_repo == "bundles/0_8b"
    assert plan.manifest_id == "eliza-1-0_8b"
    assert plan.errors == ()


def test_plan_bundle_reports_missing_manifest_file(tmp_path: Path):
    bundle = _write_bundle(tmp_path, "2b")
    (bundle / "dflash" / "drafter-2b.gguf").unlink()

    plan = P.plan_bundle(tmp_path, "2b")

    assert plan.uploadable is False
    assert any("dflash/drafter-2b.gguf" in e for e in plan.errors)


def test_voice_policy_can_warn_or_block(tmp_path: Path):
    _write_bundle(tmp_path, "2b", voice_path="tts/omnivoice-base-Q4_K_M.gguf")

    warning_plan = P.plan_bundle(tmp_path, "2b")
    strict_plan = P.plan_bundle(tmp_path, "2b", strict_voice_policy=True)

    assert warning_plan.uploadable is True
    assert any("Kokoro" in w for w in warning_plan.warnings)
    assert strict_plan.uploadable is False
    assert any("Kokoro" in e for e in strict_plan.errors)


def test_dry_run_allows_missing_with_report(tmp_path: Path, capsys):
    report = tmp_path / "report.json"

    rc = P.main(
        [
            "--bundles-root",
            str(tmp_path),
            "--tier",
            "0_8b",
            "--dry-run",
            "--allow-missing",
            "--report",
            str(report),
        ]
    )

    assert rc == 0
    assert "Eliza-1 model repo publish plan" in capsys.readouterr().out
    assert json.loads(report.read_text())["plans"][0]["tier"] == "0_8b"
