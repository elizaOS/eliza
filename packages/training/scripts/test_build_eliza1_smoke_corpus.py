"""Exercises byte-level privacy and reproducibility of the synthetic smoke corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.build_eliza1_smoke_corpus import (
    FORMATTER_PATH,
    GENERATOR_REVISION,
    MANIFEST_SCHEMA,
    OUT_DIR,
    PRIVACY_FILTER_PATH,
    SCRIPT_PATH,
    SOURCE_PATH,
    SOURCE_SCHEMA,
    artifact_mismatches,
    build_artifacts,
    write_artifacts,
)
from scripts.format_for_training import format_record


def _write_source(path: Path, record: dict, *, synthetic: bool = True) -> None:
    envelope = {
        "schema": SOURCE_SCHEMA,
        "id": "planted-privacy-row",
        "split": "train",
        "synthetic": synthetic,
        "record": record,
    }
    path.write_text(json.dumps(envelope) + "\n", encoding="utf-8")


def test_builder_serializes_redacted_formatter_bytes(tmp_path: Path) -> None:
    planted = {
        "openai_key": "sk-" + "testabcdefghijklmnopqrstu",
        "bearer": "Bearer " + "abcdefghijklmnopQRST",
        "email": "fixture.owner@example.test",
        "phone": "415-555-0137",
        "coordinates": "37.7749, -122.4194",
    }
    record = {
        "format": "eliza_native_v1",
        "boundary": "vercel_ai_sdk.generateText",
        "request": {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        f"Use {planted['openai_key']} with {planted['bearer']}; "
                        f"contact {planted['email']} or {planted['phone']} near "
                        f"{planted['coordinates']}."
                    ),
                }
            ],
            "tools": {
                planted["email"]: {
                    "description": f"Call {planted['phone']} only in this planted fixture."
                }
            },
        },
        "response": {
            "text": f"The planted contact is {planted['email']}.",
            "toolCalls": [],
        },
        "privacyAttestation": {
            "schema": "eliza.privacy_filter_attestation.v1",
            "version": 1,
            "passed": True,
            "reviewed": True,
        },
        "metadata": {"unserialized_marker": "raw-record-must-not-cross-boundary"},
    }
    source_path = tmp_path / "source.jsonl"
    output_dir = tmp_path / "output"
    _write_source(source_path, record)

    artifacts = build_artifacts(source_path)
    write_artifacts(artifacts, output_dir)
    emitted = b"".join(path.read_bytes() for path in sorted(output_dir.iterdir()))

    for sensitive_value in planted.values():
        assert sensitive_value.encode() not in emitted
    assert b"raw-record-must-not-cross-boundary" not in emitted
    assert b"<REDACTED:openai-key>" in emitted
    assert b"<REDACTED:bearer>" in emitted
    assert b"<REDACTED:contact-email>" in emitted
    assert b"<REDACTED:contact-phone>" in emitted
    assert b"[REDACTED_GEO]" in emitted

    written_rows = [
        json.loads(line)
        for line in (output_dir / "train.jsonl")
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    assert written_rows == [format_record(record)]
    assert set(written_rows[0]) == {"messages", "tools"}


def test_tracked_corpus_matches_generator_and_manifest_hashes() -> None:
    artifacts = build_artifacts(SOURCE_PATH)
    assert artifact_mismatches(artifacts, OUT_DIR) == []

    manifest = json.loads(artifacts["manifest.json"])
    assert manifest["schema"] == MANIFEST_SCHEMA
    assert manifest["source"]["kind"] == "synthetic"
    assert manifest["source"]["source_controlled"] is True
    assert manifest["source"]["external_sources"] == []
    assert (
        manifest["source"]["sha256"]
        == hashlib.sha256(SOURCE_PATH.read_bytes()).hexdigest()
    )
    assert manifest["totals"]["rows"] == 20
    assert manifest["generator"] == {
        "path": "scripts/build_eliza1_smoke_corpus.py",
        "revision": GENERATOR_REVISION,
        "sha256": hashlib.sha256(SCRIPT_PATH.read_bytes()).hexdigest(),
    }
    assert (
        manifest["transforms"]["formatter"]["sha256"]
        == hashlib.sha256(FORMATTER_PATH.read_bytes()).hexdigest()
    )
    assert (
        manifest["transforms"]["privacy_filter"]["sha256"]
        == hashlib.sha256(PRIVACY_FILTER_PATH.read_bytes()).hexdigest()
    )

    emitted_jsonl = b""
    for split in ("train", "val", "test"):
        content = artifacts[f"{split}.jsonl"]
        emitted_jsonl += content
        assert (
            manifest["splits"][split]["sha256"] == hashlib.sha256(content).hexdigest()
        )
        assert manifest["splits"][split]["bytes"] == len(content)
        for line in content.decode("utf-8").splitlines():
            assert set(json.loads(line)) <= {"messages", "tools"}

    assert b"/.eliza/" not in emitted_jsonl
    assert b"/home/" not in emitted_jsonl
    assert b"real_eliza_runtime" not in emitted_jsonl


def test_builder_rejects_unmarked_source_rows(tmp_path: Path) -> None:
    source_path = tmp_path / "source.jsonl"
    _write_source(
        source_path,
        {
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hello"},
            ]
        },
        synthetic=False,
    )

    with pytest.raises(ValueError, match="synthetic=true"):
        build_artifacts(source_path)
