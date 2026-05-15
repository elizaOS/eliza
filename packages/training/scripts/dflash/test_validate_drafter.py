from __future__ import annotations

import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.dflash import validate_drafter as validate  # noqa: E402


def _meta(
    *,
    arch: str = "qwen35",
    hashes: dict[str, str | None] | None = None,
    size_bytes: int = 100,
) -> dict:
    base_hashes = {
        key: f"hash:{key}"
        for key in validate.TOKENIZER_METADATA_KEYS
    }
    if hashes:
        base_hashes.update(hashes)
    return {
        "arch": arch,
        "sizeBytes": size_bytes,
        "tokenizer": {"hashes": base_hashes},
    }


def test_tokenizer_metadata_check_rejects_mismatched_tokens() -> None:
    ok, detail, mismatches = validate._tokenizer_metadata_check(
        _meta(hashes={"tokenizer.ggml.tokens": "drafter"}),
        _meta(hashes={"tokenizer.ggml.tokens": "target"}),
    )

    assert ok is False
    assert "tokenizer metadata mismatch" in detail
    assert mismatches == [
        {
            "key": "tokenizer.ggml.tokens",
            "targetHash": "target",
            "drafterHash": "drafter",
        }
    ]


def test_tokenizer_metadata_check_rejects_missing_required_tokens() -> None:
    ok, detail, _ = validate._tokenizer_metadata_check(
        _meta(hashes={"tokenizer.ggml.tokens": None}),
        _meta(),
    )

    assert ok is False
    assert "required tokenizer metadata missing" in detail


def test_architecture_check_rejects_dflash_draft_without_loader_evidence() -> None:
    ok, detail = validate._architecture_check(
        _meta(arch="dflash-draft"),
        _meta(arch="qwen35"),
        allow_dflash_draft_architecture=False,
    )

    assert ok is False
    assert "dflash-draft loader" in detail


def test_architecture_check_accepts_dflash_draft_with_loader_evidence() -> None:
    ok, detail = validate._architecture_check(
        _meta(arch="dflash-draft"),
        _meta(arch="qwen35"),
        allow_dflash_draft_architecture=True,
    )

    assert ok is True
    assert "architecture ok" in detail


def test_disabled_tier_validation_passes_without_drafter(tmp_path: Path) -> None:
    report = tmp_path / "report.json"

    rc = validate.main(
        [
            "--tier",
            "0_8b",
            "--report-out",
            str(report),
        ]
    )

    assert rc == 0
    payload = json.loads(report.read_text())
    assert payload["policy"]["status"] == "disabled"
    assert payload["checks"]["failOpenPolicy"]["pass"] is True
    assert payload["pass"] is True


def test_disabled_tier_validation_rejects_drafter_artifact(tmp_path: Path) -> None:
    drafter = tmp_path / "drafter-0_8b.gguf"
    drafter.write_bytes(b"fake")

    rc = validate.main(
        [
            "--tier",
            "0_8b",
            "--drafter-gguf",
            str(drafter),
        ]
    )

    assert rc == 3
