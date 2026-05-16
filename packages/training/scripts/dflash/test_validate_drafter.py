from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.dflash import validate_drafter as validate  # noqa: E402
from scripts.distill_dflash_drafter import (  # noqa: E402
    ACCEPTANCE_GATE,
    QWEN35_TOKENIZER_FAMILY_VOCAB_SIZE,
)


def _meta(
    *,
    arch: str = "qwen35",
    hashes: dict[str, str | None] | None = None,
    lengths: dict[str, int | None] | None = None,
    values: dict[str, object | None] | None = None,
    size_bytes: int = 100,
) -> dict:
    base_hashes = {
        key: f"hash:{key}"
        for key in validate.TOKENIZER_METADATA_KEYS
    }
    base_lengths = {
        "tokenizer.ggml.tokens": 248320,
        "tokenizer.ggml.token_type": 248320,
        "tokenizer.ggml.merges": 247587,
    }
    base_values = {
        "tokenizer.ggml.model": "gpt2",
        "tokenizer.ggml.pre": "qwen35",
        "tokenizer.ggml.eos_token_id": 248046,
        "tokenizer.ggml.bos_token_id": None,
        "tokenizer.ggml.padding_token_id": 248044,
        "tokenizer.ggml.add_bos_token": False,
        "tokenizer.ggml.add_eos_token": None,
    }
    if hashes:
        base_hashes.update(hashes)
    if lengths:
        base_lengths.update(lengths)
    if values:
        base_values.update(values)
    return {
        "arch": arch,
        "sizeBytes": size_bytes,
        "tokenizer": {
            "hashes": base_hashes,
            "lengths": base_lengths,
            "values": base_values,
        },
    }


def test_tokenizer_metadata_check_rejects_mismatched_tokens() -> None:
    ok, detail, mismatches = validate._tokenizer_metadata_check(
        _meta(hashes={"tokenizer.ggml.tokens": "drafter"}),
        _meta(hashes={"tokenizer.ggml.tokens": "target"}),
    )

    assert ok is False
    assert "tokenizer metadata mismatch" in detail
    assert [item["key"] for item in mismatches] == ["tokenizer.ggml.tokens"]
    assert mismatches[0]["targetHash"] == "target"
    assert mismatches[0]["drafterHash"] == "drafter"
    assert mismatches[0]["targetLength"] == 248320
    assert mismatches[0]["drafterLength"] == 248320
    assert "payload hash mismatch" in mismatches[0]["blockingReason"]


def test_tokenizer_metadata_check_rejects_token_type_and_special_id_mismatches() -> None:
    ok, detail, mismatches = validate._tokenizer_metadata_check(
        _meta(
            hashes={
                "tokenizer.ggml.token_type": "drafter-token-type",
                "tokenizer.ggml.padding_token_id": "drafter-padding",
            },
            values={"tokenizer.ggml.padding_token_id": 248044},
        ),
        _meta(
            hashes={
                "tokenizer.ggml.token_type": "target-token-type",
                "tokenizer.ggml.padding_token_id": "target-padding",
            },
            values={"tokenizer.ggml.padding_token_id": 248055},
        ),
    )

    assert ok is False
    assert "tokenizer.ggml.token_type" in detail
    assert "tokenizer.ggml.padding_token_id" in detail
    assert [item["key"] for item in mismatches] == [
        "tokenizer.ggml.token_type",
        "tokenizer.ggml.padding_token_id",
    ]
    assert "payload hash mismatch" in mismatches[0]["blockingReason"]
    assert (
        mismatches[1]["blockingReason"]
        == "tokenizer.ggml.padding_token_id value mismatch: target=248055, drafter=248044"
    )


def test_tokenizer_metadata_check_rejects_missing_required_tokens() -> None:
    ok, detail, _ = validate._tokenizer_metadata_check(
        _meta(hashes={"tokenizer.ggml.tokens": None}),
        _meta(),
    )

    assert ok is False
    assert "required tokenizer metadata missing" in detail


def test_tokenizer_metadata_check_rejects_missing_required_on_both_sides() -> None:
    ok, detail, mismatches = validate._tokenizer_metadata_check(
        _meta(hashes={"tokenizer.ggml.merges": None}),
        _meta(hashes={"tokenizer.ggml.merges": None}),
    )

    assert ok is False
    assert "tokenizer.ggml.merges missing from target and drafter" in detail
    assert mismatches[0]["required"] is True
    assert mismatches[0]["targetHash"] is None
    assert mismatches[0]["drafterHash"] is None


def test_hash_or_metadata_check_rejects_wrong_target_checkpoint(
    tmp_path: Path,
) -> None:
    target = tmp_path / "target.gguf"
    target.write_bytes(b"target-weights")

    ok, detail = validate._hash_or_metadata_check(
        {"targetCheckpointSha256": "0" * 64},
        target,
    )

    assert ok is False
    assert "target hash mismatch" in detail
    assert "drafter recorded " + "0" * 64 in detail


def test_real_validation_skips_acceptance_after_metadata_failure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    target = tmp_path / "target.gguf"
    drafter = tmp_path / "drafter.gguf"
    report_path = tmp_path / "report.json"
    target.write_bytes(b"target")
    drafter.write_bytes(b"drafter")
    target_sha = "a" * 64

    target_meta = _meta(size_bytes=200)
    drafter_meta = _meta(
        hashes={"tokenizer.ggml.tokens": "wrong-tokenizer"},
        size_bytes=100,
    )
    drafter_meta["targetCheckpointSha256"] = target_sha

    def fake_read_metadata(path: Path) -> dict:
        return drafter_meta if path == drafter else target_meta

    def fail_rollout(*_args, **_kwargs) -> dict:
        raise AssertionError("acceptance rollout must not run after preflight failure")

    monkeypatch.setattr(validate, "_read_gguf_metadata", fake_read_metadata)
    monkeypatch.setattr(validate, "_sha256_file", lambda _path: target_sha)
    monkeypatch.setattr(validate, "_run_acceptance_rollout", fail_rollout)

    rc = validate._run_real(
        argparse.Namespace(
            tier="2b",
            drafter_gguf=str(drafter),
            target_gguf=str(target),
            allow_dflash_draft_architecture=False,
            skip_acceptance_rollout=False,
            prompts_file=None,
            acceptance_tokens=8,
            acceptance_gate=None,
            report_out=str(report_path),
        )
    )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert rc == 3
    assert report["checks"]["tokenizerMetadataMatch"]["pass"] is False
    assert report["checks"]["acceptanceRollout"]["pass"] is False
    assert "skipped because release metadata checks failed" in report["checks"][
        "acceptanceRollout"
    ]["detail"]
    assert "tokenizer.ggml.tokens payload hash mismatch" in report["checks"][
        "acceptanceRollout"
    ]["detail"]


def test_metadata_only_mode_skips_full_target_hash_and_fails_closed(
    tmp_path: Path,
    monkeypatch,
) -> None:
    target = tmp_path / "target.gguf"
    drafter = tmp_path / "drafter.gguf"
    report_path = tmp_path / "report.json"
    target.write_bytes(b"target")
    drafter.write_bytes(b"drafter")

    target_meta = _meta(size_bytes=200)
    drafter_meta = _meta(size_bytes=100)
    drafter_meta["targetCheckpointSha256"] = "a" * 64

    def fake_read_metadata(path: Path) -> dict:
        return drafter_meta if path == drafter else target_meta

    def fail_hash(_path: Path) -> str:
        raise AssertionError("metadata-only validation must not hash target bytes")

    def fail_rollout(*_args, **_kwargs) -> dict:
        raise AssertionError("metadata-only validation must not run acceptance rollout")

    monkeypatch.setattr(validate, "_read_gguf_metadata", fake_read_metadata)
    monkeypatch.setattr(validate, "_sha256_file", fail_hash)
    monkeypatch.setattr(validate, "_run_acceptance_rollout", fail_rollout)

    rc = validate._run_real(
        argparse.Namespace(
            tier="2b",
            drafter_gguf=str(drafter),
            target_gguf=str(target),
            allow_dflash_draft_architecture=False,
            metadata_only=True,
            skip_acceptance_rollout=True,
            prompts_file=None,
            acceptance_tokens=8,
            acceptance_gate=None,
            report_out=str(report_path),
        )
    )

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert rc == 3
    assert report["metadataOnly"] is True
    assert report["pass"] is False
    assert report["checks"]["hashMatch"]["pass"] is False
    assert "skipped (--metadata-only)" in report["checks"]["hashMatch"]["detail"]
    assert report["checks"]["tokenizerMetadataMatch"]["pass"] is True


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


def test_acceptance_gates_are_imported_from_distill_source_of_truth() -> None:
    assert validate.ACCEPTANCE_GATE is ACCEPTANCE_GATE
    assert validate.ACCEPTANCE_GATE["2b"] == 0.48
    assert validate.ACCEPTANCE_GATE["9b"] == 0.52


def test_synthetic_smoke_uses_current_qwen35_vocab_fixture(tmp_path: Path) -> None:
    report_path = tmp_path / "validate.json"

    rc = validate._run_synthetic_smoke(
        argparse.Namespace(tier="2b", report_out=str(report_path))
    )

    assert rc == 0
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["drafter"]["vocabSize"] == QWEN35_TOKENIZER_FAMILY_VOCAB_SIZE
    assert report["target"]["vocabSize"] == QWEN35_TOKENIZER_FAMILY_VOCAB_SIZE
