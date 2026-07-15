"""Exercises byte-level privacy and reproducibility of the synthetic smoke corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import scripts.build_eliza1_smoke_corpus as corpus_builder
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


def _write_source(
    path: Path,
    record: dict,
    *,
    synthetic: bool = True,
    splits: tuple[str, ...] = ("train",),
) -> None:
    envelopes = [
        {
            "schema": SOURCE_SCHEMA,
            "id": f"planted-privacy-row-{split}",
            "split": split,
            "synthetic": synthetic,
            "record": record,
        }
        for split in splits
    ]
    path.write_text(
        "".join(f"{json.dumps(envelope)}\n" for envelope in envelopes),
        encoding="utf-8",
    )


def test_builder_serializes_redacted_formatter_bytes(tmp_path: Path) -> None:
    planted = {
        "openai_key": "sk-" + "testabcdefghijklmnopqrstu",
        "bearer": "Bearer " + "abcdefghijklmnopQRST",
        "email": "fixture.owner@example.test",
        "phone": "415-555-0137",
        "coordinates": "37.7749, -122.4194",
        "numeric_latitude": 40.7128,
        "numeric_longitude": -74.0060,
        "geojson_longitude": -118.2437,
        "geojson_latitude": 34.0522,
        "line_longitude": -87.6298,
        "line_latitude": 41.8781,
        "polygon_longitude": -80.1918,
        "polygon_latitude": 25.7617,
        "alias_latitude": 33.4484,
        "alias_lng_upper": -112.0740,
        "alias_lng_lower": -104.9903,
        "alias_longitude": -77.0369,
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
                    "parts": [
                        {
                            "type": "data",
                            "data": {
                                "latitude": planted["numeric_latitude"],
                                "longitude": planted["numeric_longitude"],
                            },
                        }
                    ],
                }
            ],
            "tools": {
                planted["email"]: {
                    "description": f"Call {planted['phone']} only in this planted fixture.",
                    "parameters": {
                        "default": {
                            "latitude": planted["numeric_latitude"],
                            "longitude": planted["numeric_longitude"],
                        },
                        "example": {
                            "coordinates": [
                                planted["numeric_latitude"],
                                planted["numeric_longitude"],
                            ]
                        },
                        "geojson": {
                            "type": "Point",
                            "coordinates": [
                                planted["geojson_longitude"],
                                planted["geojson_latitude"],
                            ],
                        },
                        "route": {
                            "type": "LineString",
                            "coordinates": [
                                [
                                    planted["line_longitude"],
                                    planted["line_latitude"],
                                ],
                                [
                                    planted["geojson_longitude"],
                                    planted["geojson_latitude"],
                                ],
                            ],
                        },
                        "area": {
                            "type": "Polygon",
                            "coordinates": [
                                [
                                    [
                                        planted["polygon_longitude"],
                                        planted["polygon_latitude"],
                                    ],
                                    [
                                        planted["line_longitude"],
                                        planted["line_latitude"],
                                    ],
                                ]
                            ],
                        },
                        "duplicateAliases": {
                            "lat": planted["alias_latitude"],
                            "LNG": planted["alias_lng_upper"],
                            "lng": planted["alias_lng_lower"],
                            "longitude": planted["alias_longitude"],
                        },
                    },
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
    _write_source(source_path, record, splits=("train", "val", "test"))

    artifacts = build_artifacts(source_path)
    write_artifacts(artifacts, output_dir)
    emitted = b"".join(path.read_bytes() for path in sorted(output_dir.iterdir()))

    for sensitive_value in planted.values():
        assert str(sensitive_value).encode() not in emitted
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
    assert {
        split: manifest["splits"][split]["rows"] for split in ("train", "val", "test")
    } == {"train": 16, "val": 2, "test": 2}
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


def test_builder_rejects_missing_required_splits(tmp_path: Path) -> None:
    source_path = tmp_path / "source.jsonl"
    _write_source(
        source_path,
        {
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hello"},
            ]
        },
    )

    with pytest.raises(ValueError, match="every split must contain"):
        build_artifacts(source_path)


def test_repo_reference_marks_in_repo_untracked_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        corpus_builder.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stderr=""),
    )

    reference, source_controlled = corpus_builder._repo_reference(SOURCE_PATH)

    assert reference == "fixtures/eliza1-smoke-source.jsonl"
    assert source_controlled is False


def test_repo_reference_fails_when_git_cannot_check_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        corpus_builder.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=128, stderr="fatal: unavailable"
        ),
    )

    with pytest.raises(RuntimeError, match="git could not determine"):
        corpus_builder._repo_reference(SOURCE_PATH)
