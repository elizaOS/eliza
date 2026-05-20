#!/usr/bin/env python3
"""Run ``qemu_virt_boot.sh`` and validate the resulting evidence JSON.

This wrapper is the canonical entry point used by the variant's ``Makefile``
``qemu-virt-boot`` and ``qemu-virt-boot-evidence`` targets. It runs the bash
harness with the provided arguments (or defaults) and then validates that the
JSON evidence file conforms to the ``eliza.os.linux.qemu_virt_boot.v1``
schema enforced here.

The script is structured so its validation primitives can be unit-tested
without launching QEMU. See ``test_qemu_virt_smoke.py``.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VARIANT_DIR = HERE.parent
BASH_HARNESS = HERE / "qemu_virt_boot.sh"

EVIDENCE_SCHEMA = "eliza.os.linux.qemu_virt_boot.v1"
CLAIM_BOUNDARY = (
    "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim"
)
PROVENANCE = "qemu_virt"

# Fields that must be present in a valid evidence document, mapped to the
# expected Python type tuple. ``bool`` is checked separately because in Python
# ``isinstance(True, int)`` is ``True``.
_REQUIRED_FIELDS: dict[str, tuple[type, ...]] = {
    "schema": (str,),
    "claim_boundary": (str,),
    "iso_path": (str,),
    "iso_sha256": (str,),
    "transcript_path": (str,),
    "transcript_sha256": (str,),
    "memory_mb": (int,),
    "cpus": (int,),
    "timeout_s": (int,),
    "duration_s": (int,),
    "start_utc": (str,),
    "qemu_exit_code": (int,),
    "u_boot_path": (str, type(None)),
    "boot_completed": (bool,),
    "markers_found": (list,),
    "markers_missing": (list,),
    "forbidden_markers_present": (list,),
    "provenance": (str,),
}

REQUIRED_MARKERS = (
    "Linux version",
    "systemd[1]: System Initialized",
)


class EvidenceValidationError(ValueError):
    """Raised when an evidence JSON document fails schema validation."""


def _is_sha256(value: str) -> bool:
    if len(value) != 64:
        return False
    return all(c in "0123456789abcdef" for c in value)


def _check_type(field: str, value: Any, expected: tuple[type, ...]) -> None:
    if bool in expected and isinstance(value, bool):
        return
    if bool not in expected and isinstance(value, bool):
        raise EvidenceValidationError(
            f"field {field!r} is bool but expected {expected!r}"
        )
    if not isinstance(value, expected):
        raise EvidenceValidationError(
            f"field {field!r} has type {type(value).__name__}, expected {expected!r}"
        )


def _validate_string_list(field: str, value: Iterable[Any]) -> None:
    for idx, item in enumerate(value):
        if not isinstance(item, str):
            raise EvidenceValidationError(
                f"field {field!r}[{idx}] is not a string: {item!r}"
            )


def validate_evidence(doc: dict[str, Any]) -> None:
    """Validate an evidence document against the v1 schema.

    Raises:
        EvidenceValidationError: when any required field is missing, has the
            wrong type, or carries an invalid value (bad sha256, wrong schema
            string, wrong claim_boundary, etc.).
    """
    if not isinstance(doc, dict):
        raise EvidenceValidationError(
            f"evidence root is {type(doc).__name__}, expected dict"
        )

    missing = sorted(set(_REQUIRED_FIELDS) - set(doc))
    if missing:
        raise EvidenceValidationError(f"evidence missing fields: {missing}")

    for field, expected in _REQUIRED_FIELDS.items():
        _check_type(field, doc[field], expected)

    if doc["schema"] != EVIDENCE_SCHEMA:
        raise EvidenceValidationError(
            f"schema mismatch: {doc['schema']!r} != {EVIDENCE_SCHEMA!r}"
        )
    if doc["claim_boundary"] != CLAIM_BOUNDARY:
        raise EvidenceValidationError(
            f"claim_boundary mismatch: {doc['claim_boundary']!r}"
        )
    if doc["provenance"] != PROVENANCE:
        raise EvidenceValidationError(
            f"provenance mismatch: {doc['provenance']!r} != {PROVENANCE!r}"
        )

    if not _is_sha256(doc["iso_sha256"]):
        raise EvidenceValidationError(f"iso_sha256 is not hex64: {doc['iso_sha256']!r}")
    if not _is_sha256(doc["transcript_sha256"]):
        raise EvidenceValidationError(
            f"transcript_sha256 is not hex64: {doc['transcript_sha256']!r}"
        )

    for numeric in ("memory_mb", "cpus", "timeout_s", "duration_s"):
        if doc[numeric] < 0:
            raise EvidenceValidationError(
                f"{numeric} must be non-negative, got {doc[numeric]}"
            )

    _validate_string_list("markers_found", doc["markers_found"])
    _validate_string_list("markers_missing", doc["markers_missing"])
    _validate_string_list("forbidden_markers_present", doc["forbidden_markers_present"])

    if doc["boot_completed"]:
        if doc["forbidden_markers_present"]:
            raise EvidenceValidationError(
                "boot_completed=true but forbidden_markers_present is non-empty"
            )
        for marker in REQUIRED_MARKERS:
            if marker not in doc["markers_found"]:
                raise EvidenceValidationError(
                    f"boot_completed=true but required marker missing: {marker!r}"
                )


def load_evidence(path: Path) -> dict[str, Any]:
    """Read and JSON-decode an evidence file.

    Raises:
        FileNotFoundError: if ``path`` does not exist.
        EvidenceValidationError: if the file is not valid JSON.
    """
    if not path.is_file():
        raise FileNotFoundError(f"evidence file not found: {path}")
    raw = path.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EvidenceValidationError(f"evidence file is not JSON: {exc}") from exc


def run_harness(
    iso: Path,
    *,
    memory_mb: int = 4096,
    cpus: int = 4,
    timeout_s: int = 600,
    evidence_path: Path | None = None,
    transcript_path: Path | None = None,
    u_boot: Path | None = None,
    bash_harness: Path = BASH_HARNESS,
) -> subprocess.CompletedProcess[str]:
    """Invoke the bash harness with the given parameters.

    Returns the completed process. Does not raise on non-zero exit; callers
    decide how to react. The caller should always validate the evidence file
    even when the process exits non-zero (a failed boot is still recorded).
    """
    if not bash_harness.is_file():
        raise FileNotFoundError(f"bash harness not found: {bash_harness}")
    if not iso.is_file():
        raise FileNotFoundError(f"ISO not found: {iso}")

    cmd: list[str] = [
        "bash",
        str(bash_harness),
        "--iso",
        str(iso),
        "--memory",
        str(memory_mb),
        "--cpus",
        str(cpus),
        "--timeout",
        str(timeout_s),
    ]
    if evidence_path is not None:
        cmd.extend(["--evidence", str(evidence_path)])
    if transcript_path is not None:
        cmd.extend(["--transcript", str(transcript_path)])
    if u_boot is not None:
        cmd.extend(["--u-boot", str(u_boot)])

    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run qemu_virt_boot.sh and validate the evidence JSON.",
    )
    parser.add_argument("--iso", type=Path, required=True, help="path to live ISO")
    parser.add_argument("--memory", type=int, default=4096, help="QEMU memory in MB")
    parser.add_argument("--cpus", type=int, default=4, help="QEMU CPU count")
    parser.add_argument("--timeout", type=int, default=600, help="boot timeout (s)")
    parser.add_argument(
        "--evidence",
        type=Path,
        default=VARIANT_DIR / "evidence" / "qemu_virt_boot.json",
        help="evidence JSON output path",
    )
    parser.add_argument(
        "--transcript",
        type=Path,
        default=VARIANT_DIR / "evidence" / "qemu_virt_boot.transcript.log",
        help="boot transcript output path",
    )
    parser.add_argument(
        "--u-boot",
        type=Path,
        default=None,
        help="optional U-Boot ELF to load via -kernel",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if not args.iso.is_file():
        print(f"qemu_virt_smoke: ERROR: ISO not found: {args.iso}", file=sys.stderr)
        return 2

    result = run_harness(
        args.iso,
        memory_mb=args.memory,
        cpus=args.cpus,
        timeout_s=args.timeout,
        evidence_path=args.evidence,
        transcript_path=args.transcript,
        u_boot=args.u_boot,
    )
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)

    try:
        doc = load_evidence(args.evidence)
        validate_evidence(doc)
    except (FileNotFoundError, EvidenceValidationError) as exc:
        print(f"qemu_virt_smoke: ERROR: {exc}", file=sys.stderr)
        return 2

    if not doc["boot_completed"]:
        print(
            "qemu_virt_smoke: FAIL: boot_completed=false; "
            f"markers_missing={doc['markers_missing']} "
            f"forbidden_markers_present={doc['forbidden_markers_present']}",
            file=sys.stderr,
        )
        return 1

    print(
        f"qemu_virt_smoke: PASS: evidence={args.evidence} "
        f"duration_s={doc['duration_s']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
