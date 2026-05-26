"""Tests for Eliza-1 evidence finalization gates."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import finalize_eliza1_evidence as F  # noqa: E402


def test_upload_evidence_requires_complete_platform_upload_paths() -> None:
    required = F._required_uploaded_paths("2b")
    incomplete = sorted(required - {"bundles/2b/mtp/drafter-2b.gguf"})

    assert not F._has_upload_evidence(
        {
            "hf": {
                "repoId": F.ELIZA_1_HF_REPO,
                "status": "uploaded",
                "uploadEvidence": {
                    "repoId": F.ELIZA_1_HF_REPO,
                    "status": "uploaded",
                    "commit": "abc123",
                    "url": "https://huggingface.co/elizaos/eliza-1/commit/abc123",
                    "uploadedPaths": incomplete,
                },
            }
        },
        "2b",
    )
    assert F._has_upload_evidence(
        {
            "hf": {
                "repoId": F.ELIZA_1_HF_REPO,
                "status": "uploaded",
                "uploadEvidence": {
                    "repoId": F.ELIZA_1_HF_REPO,
                    "status": "uploaded",
                    "commit": "abc123",
                    "url": "https://huggingface.co/elizaos/eliza-1/commit/abc123",
                    "uploadedPaths": sorted(required),
                },
            }
        },
        "2b",
    )


def test_platform_plan_errors_block_missing_required_files_and_manifest_payloads(
    tmp_path: Path,
) -> None:
    bundle = tmp_path / "eliza-1-2b.bundle"
    (bundle / "text").mkdir(parents=True)
    (bundle / "text" / "eliza-1-2b-128k.gguf").write_bytes(b"text")
    (bundle / "eliza-1.manifest.json").write_text(
        json.dumps(
            {
                "tier": "2b",
                "files": {
                    "text": [
                        {
                            "path": "text/eliza-1-2b-128k.gguf",
                            "sha256": "0" * 64,
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    errors = F._platform_plan_errors(bundle, "2b")

    assert any("platform plan missing required file" in error for error in errors)
    assert any("text/eliza-1-2b-256k.gguf" in error for error in errors)
    assert any(
        "manifest missing platform-plan payload path" in error for error in errors
    )

