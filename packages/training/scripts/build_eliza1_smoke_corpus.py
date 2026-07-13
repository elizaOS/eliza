#!/usr/bin/env python3
"""Build the tracked Eliza-1 pipeline-smoke corpus from synthetic records.

The source fixture assigns each row to a split and marks it synthetic. The
builder writes only the object returned by ``format_record`` so the canonical
privacy filter is the serialization boundary, then records content hashes for
the complete regeneration chain in a deterministic manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = Path(__file__).resolve()
sys.path.insert(0, str(ROOT / "scripts"))

from format_for_training import format_record  # noqa: E402

SOURCE_PATH = ROOT / "fixtures" / "eliza1-smoke-source.jsonl"
OUT_DIR = ROOT / "data" / "final-eliza1-smoke"
FORMATTER_PATH = ROOT / "scripts" / "format_for_training.py"
PRIVACY_FILTER_PATH = ROOT / "scripts" / "privacy_filter_trajectories.py"

SOURCE_SCHEMA = "eliza.synthetic_smoke_source.v1"
MANIFEST_SCHEMA = "eliza.eliza1_smoke_corpus_manifest.v2"
GENERATOR_REVISION = 3
SPLIT_NAMES = ("train", "val", "test")
SOURCE_FIELDS = {"schema", "id", "split", "synthetic", "record"}
SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,95}$")


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _repo_reference(path: Path) -> tuple[str, bool]:
    resolved = path.resolve()
    try:
        relative = resolved.relative_to(ROOT.resolve()).as_posix()
    except (
        ValueError
    ):  # error-policy:J3 Hash external paths instead of serializing local provenance.
        # Custom sources used by tests/operators must not leak machine-local
        # absolute paths into the manifest.
        return f"external/sha256:{_sha256_file(resolved)[:16]}", False

    tracked = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "--error-unmatch", "--", relative],
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )
    if tracked.returncode not in (0, 1):
        raise RuntimeError(
            f"git could not determine source provenance: {tracked.stderr.strip()}"
        )
    return relative, tracked.returncode == 0


def _jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    lines = [
        json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        for row in rows
    ]
    return ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")


def _load_and_format_source(
    source_path: Path,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[str]]]:
    """Validate the synthetic envelope and return privacy-filtered rows."""

    splits: dict[str, list[dict[str, Any]]] = {name: [] for name in SPLIT_NAMES}
    ids: dict[str, list[str]] = {name: [] for name in SPLIT_NAMES}
    seen_ids: set[str] = set()

    with source_path.open(encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            if not raw_line.strip():
                raise ValueError(
                    f"{source_path}:{line_number}: blank JSONL rows are not allowed"
                )
            try:
                envelope = json.loads(raw_line)
            except (
                json.JSONDecodeError
            ) as exc:  # error-policy:J3 Reject malformed source rows explicitly.
                raise ValueError(
                    f"{source_path}:{line_number}: invalid JSON: {exc.msg}"
                ) from exc
            if not isinstance(envelope, dict):
                raise ValueError(
                    f"{source_path}:{line_number}: source row must be an object"
                )

            fields = set(envelope)
            if fields != SOURCE_FIELDS:
                missing = sorted(SOURCE_FIELDS - fields)
                unexpected = sorted(fields - SOURCE_FIELDS)
                raise ValueError(
                    f"{source_path}:{line_number}: source envelope fields differ; "
                    f"missing={missing}, unexpected={unexpected}"
                )
            if envelope["schema"] != SOURCE_SCHEMA:
                raise ValueError(
                    f"{source_path}:{line_number}: expected schema {SOURCE_SCHEMA!r}"
                )
            if envelope["synthetic"] is not True:
                raise ValueError(
                    f"{source_path}:{line_number}: source row must declare synthetic=true"
                )

            row_id = envelope["id"]
            if not isinstance(row_id, str) or SOURCE_ID_RE.fullmatch(row_id) is None:
                raise ValueError(
                    f"{source_path}:{line_number}: id must match {SOURCE_ID_RE.pattern!r}"
                )
            if row_id in seen_ids:
                raise ValueError(
                    f"{source_path}:{line_number}: duplicate id {row_id!r}"
                )
            seen_ids.add(row_id)

            split = envelope["split"]
            if not isinstance(split, str) or split not in splits:
                raise ValueError(
                    f"{source_path}:{line_number}: split must be one of {SPLIT_NAMES}"
                )
            record = envelope["record"]
            if not isinstance(record, dict):
                raise ValueError(
                    f"{source_path}:{line_number}: record must be an object"
                )

            formatted = format_record(record)
            if formatted is None:
                raise ValueError(
                    f"{source_path}:{line_number}: format_record rejected source id {row_id!r}"
                )

            # This returned object is the privacy-filtered representation. It
            # is deliberately the only record that can cross the write boundary.
            splits[split].append(formatted)
            ids[split].append(row_id)

    if not seen_ids:
        raise ValueError(f"{source_path}: source fixture is empty")
    empty_splits = [name for name in SPLIT_NAMES if not splits[name]]
    if empty_splits:
        raise ValueError(
            f"{source_path}: every split must contain at least one row; "
            f"empty={empty_splits}"
        )
    return splits, ids


def build_artifacts(source_path: Path = SOURCE_PATH) -> dict[str, bytes]:
    """Return every generated artifact as deterministic UTF-8 bytes."""

    source_path = source_path.resolve()
    splits, ids = _load_and_format_source(source_path)
    split_artifacts = {
        f"{name}.jsonl": _jsonl_bytes(splits[name]) for name in SPLIT_NAMES
    }
    source_reference, source_controlled = _repo_reference(source_path)

    split_manifest = {}
    for name in SPLIT_NAMES:
        content = split_artifacts[f"{name}.jsonl"]
        split_manifest[name] = {
            "bytes": len(content),
            "ids": ids[name],
            "rows": len(splits[name]),
            "sha256": _sha256_bytes(content),
        }

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "purpose": (
            "Tiny synthetic fixture for exercising corpus formatting and the "
            "end-to-end SFT pipeline; it is not a quality-training corpus."
        ),
        "generator": {
            "path": SCRIPT_PATH.relative_to(ROOT).as_posix(),
            "revision": GENERATOR_REVISION,
            "sha256": _sha256_file(SCRIPT_PATH),
        },
        "source": {
            "external_sources": [],
            "kind": "synthetic",
            "license": "MIT",
            "path": source_reference,
            "rows": sum(len(rows) for rows in splits.values()),
            "schema": SOURCE_SCHEMA,
            "sha256": _sha256_file(source_path),
            "source_controlled": source_controlled,
        },
        "transforms": {
            "formatter": {
                "path": FORMATTER_PATH.relative_to(ROOT).as_posix(),
                "sha256": _sha256_file(FORMATTER_PATH),
            },
            "privacy_filter": {
                "applied": True,
                "path": PRIVACY_FILTER_PATH.relative_to(ROOT).as_posix(),
                "sha256": _sha256_file(PRIVACY_FILTER_PATH),
            },
        },
        "serialization": {
            "encoding": "utf-8",
            "json": "compact with lexicographically sorted object keys",
            "newline": "LF",
            "record": "exact object returned by format_record",
            "split_assignment": "explicit source envelope; source order preserved",
        },
        "splits": split_manifest,
        "totals": {
            "bytes": sum(len(content) for content in split_artifacts.values()),
            "rows": sum(len(rows) for rows in splits.values()),
        },
    }
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    return {**split_artifacts, "manifest.json": manifest_bytes}


def write_artifacts(artifacts: dict[str, bytes], output_dir: Path = OUT_DIR) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename, content in artifacts.items():
        (output_dir / filename).write_bytes(content)


def artifact_mismatches(
    artifacts: dict[str, bytes], output_dir: Path = OUT_DIR
) -> list[str]:
    mismatches: list[str] = []
    for filename, expected in artifacts.items():
        path = output_dir / filename
        if not path.exists():
            mismatches.append(f"missing {path}")
        elif path.read_bytes() != expected:
            mismatches.append(f"stale {path}")
    return mismatches


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE_PATH)
    parser.add_argument("--output-dir", type=Path, default=OUT_DIR)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify tracked artifacts byte-for-byte without writing",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    artifacts = build_artifacts(args.source)
    if args.check:
        mismatches = artifact_mismatches(artifacts, args.output_dir)
        if mismatches:
            for mismatch in mismatches:
                print(mismatch, file=sys.stderr)
            return 1
        print(f"smoke corpus is reproducible: {len(artifacts)} artifacts match")
        return 0

    write_artifacts(artifacts, args.output_dir)
    manifest = json.loads(artifacts["manifest.json"])
    counts = ", ".join(
        f"{name}={manifest['splits'][name]['rows']}" for name in SPLIT_NAMES
    )
    print(f"wrote deterministic synthetic smoke corpus ({counts}) to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
