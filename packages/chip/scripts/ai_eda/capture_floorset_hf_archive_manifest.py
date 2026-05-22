#!/usr/bin/env python3
"""Capture local Hugging Face FloorSet archive hash evidence.

This is a payload-integrity gate only. It does not unpack archives, convert
records, train models, or claim E1 optimization/signoff.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PAYLOAD = ROOT / "external/datasets/intel-floorset/payload/LiteTensorData"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/floorset_hf_archives"
SCHEMA = "eliza.ai_eda.floorset_hf_archive_manifest.v1"
CLAIM_BOUNDARY = "floorset_hf_archive_hash_manifest_no_unpack_training_or_release_claim"
DATASET_ID = "IntelLabs/FloorSet"
ASSET_ID = "intel-floorset"
HF_ARCHIVE_RUN_ID = "codex-floorset-hf-archives-20260521"
EXPECTED_SIZE_MARKER = "github_checkout_plus_hf_archives_29665773263_verified_bytes"
RECORDED_INTAKE_STATUS = "RECORDED_IN_REVIEWED_INTAKE"

EXPECTED_ARCHIVES: tuple[dict[str, Any], ...] = (
    {
        "filename": ".gitattributes",
        "size_bytes": 2307,
        "sha256": None,
        "required": True,
    },
    {
        "filename": "README.md",
        "size_bytes": 3133,
        "sha256": None,
        "required": True,
    },
    {
        "filename": "floorset_readme",
        "size_bytes": 19,
        "sha256": None,
        "required": True,
    },
    {
        "filename": "dataset21_lite.pth",
        "size_bytes": 38917590,
        "sha256": "386e79bbdaead00899763aa209a641fed53b867699f80a20d6d1afd6e624fb3d",
        "required": True,
    },
    {
        "filename": "floorset_lite.tgz",
        "size_bytes": 2673112636,
        "sha256": "93b905f4ea30899d42ebf9be508dfed405fa3d4f024445c6e00c9aa8ae9f8fcd",
        "required": True,
    },
    {
        "filename": "LiteTensorData.tar.gz",
        "size_bytes": 5091364786,
        "sha256": "bd4dcff6f1704f22dd18f558254ffc2c967256bfaa7438093eee5f8b3aee1057",
        "required": True,
    },
    {
        "filename": "LiteTensorData_v2.tar.gz",
        "size_bytes": 6627425876,
        "sha256": "dad21c725a31185a826b0bac4c392e8c0d4de0f21d143b431ab70366f75daf82",
        "required": True,
    },
    {
        "filename": "LiteTensorDataTest.tar.gz",
        "size_bytes": 69379249,
        "sha256": "91535933f301f5bd3e3b00a7380f463d5eb654bfddc069ef5d1e5b9813854c6d",
        "required": True,
    },
    {
        "filename": "PrimeTensorData.tar.gz",
        "size_bytes": 15164064196,
        "sha256": "495453581a07d48c5639d5d4ba3a4fe64cbe4aa7811cf9d056cae98b436960e3",
        "required": True,
    },
    {
        "filename": "PrimeTensorDataTest.tar.gz",
        "size_bytes": 1503471,
        "sha256": "f57621379c97b63f06bf9270b6da5f8b49424a20b23aa2f8a0f2b477deccf75a",
        "required": True,
    },
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def source_lock_entry(lockfile: dict[str, Any]) -> dict[str, Any]:
    entries = lockfile.get("entries")
    if not isinstance(entries, list):
        return {}
    for entry in entries:
        if isinstance(entry, dict) and entry.get("id") == ASSET_ID:
            return entry
    return {}


def metadata_review_complete() -> bool:
    intake = load_yaml(ROOT / "external/datasets/intel-floorset/manifest.yaml")
    lock_entry = source_lock_entry(load_yaml(ROOT / "external/SOURCES.lock.yaml"))
    payload_info = as_mapping(intake.get("local_payload"))
    validation = as_mapping(lock_entry.get("validation"))
    checksum_status = str(payload_info.get("checksum_status", ""))
    lock_checksum_status = str(lock_entry.get("checksum_status", ""))
    return (
        intake.get("asset_id") == ASSET_ID
        and payload_info.get("downloaded") is True
        and HF_ARCHIVE_RUN_ID in checksum_status
        and lock_entry.get("expected_size") == EXPECTED_SIZE_MARKER
        and HF_ARCHIVE_RUN_ID in lock_checksum_status
        and lock_entry.get("allowed_use") == "training-only"
        and validation.get("hash_verification") == "complete"
        and validation.get("license_review") == "complete_training_only_2026-05-21"
        and validation.get("provenance_review") == "complete"
    )


def file_status(payload: Path, spec: dict[str, Any], *, allow_recorded: bool) -> dict[str, Any]:
    path = payload / spec["filename"]
    present = path.is_file()
    actual_size = path.stat().st_size if present else None
    digest = sha256_file(path) if present and spec.get("sha256") else None
    size_ok = present and actual_size == spec["size_bytes"]
    sha_ok = spec.get("sha256") is None or digest == spec["sha256"]
    status = "VERIFIED" if size_ok and sha_ok else "MISSING"
    if present and not size_ok:
        status = "SIZE_MISMATCH_OR_PARTIAL"
    elif present and size_ok and not sha_ok:
        status = "SHA256_MISMATCH"
    elif not present and allow_recorded:
        status = RECORDED_INTAKE_STATUS
    return {
        "filename": spec["filename"],
        "path": rel(path),
        "present": present,
        "required": spec["required"],
        "expected_size_bytes": spec["size_bytes"],
        "actual_size_bytes": actual_size,
        "expected_sha256": spec.get("sha256"),
        "actual_sha256": digest,
        "status": status,
        "source": "external/datasets/intel-floorset/manifest.yaml + external/SOURCES.lock.yaml"
        if status == RECORDED_INTAKE_STATUS
        else None,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--payload", type=Path, default=DEFAULT_PAYLOAD)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    allow_recorded = metadata_review_complete()
    records = [
        file_status(args.payload, spec, allow_recorded=allow_recorded) for spec in EXPECTED_ARCHIVES
    ]
    blockers = [
        f"{record['filename']}: {record['status']}"
        for record in records
        if record["required"] and record["status"] not in {"VERIFIED", RECORDED_INTAKE_STATUS}
    ]
    verified_bytes = sum(
        int(record["actual_size_bytes"] or record["expected_size_bytes"] or 0)
        for record in records
        if record["status"] in {"VERIFIED", RECORDED_INTAKE_STATUS}
    )
    expected_bytes = sum(int(spec["size_bytes"]) for spec in EXPECTED_ARCHIVES)
    report = {
        "schema": SCHEMA,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "dataset_id": DATASET_ID,
        "payload_path": rel(args.payload),
        "manifest_basis": "local_payload_files"
        if not allow_recorded
        else "checked_in_intake_and_source_lock_metadata",
        "archive_count": len(records),
        "verified_archive_count": sum(
            1 for record in records if record["status"] in {"VERIFIED", RECORDED_INTAKE_STATUS}
        ),
        "expected_total_bytes": expected_bytes,
        "verified_total_bytes": verified_bytes,
        "release_use_allowed": False,
        "training_use_allowed": not blockers,
        "unpack_claim_allowed": False,
        "e1_signoff_claim_allowed": False,
        "status": "VERIFIED_FULL_HF_ARCHIVE_SET"
        if not blockers
        else "BLOCKED_INCOMPLETE_HF_ARCHIVE_SET",
        "archives": records,
        "blockers": blockers,
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "archive_manifest.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    result = "PASS" if not blockers else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{result} ai_eda.floorset_hf_archive_manifest status={report['status']} "
        f"verified={report['verified_archive_count']}/{report['archive_count']} {rel(path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
