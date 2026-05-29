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
import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
VARIANT_DIR = HERE.parent
BASH_HARNESS = HERE / "qemu_virt_boot_riscv64.sh"


def _repo_root_from_variant(variant_dir: Path) -> Path:
    """Return the repository root when the variant is inside packages/os.

    The script is often run from a Docker bind mount such as /build, where
    ``Path.parents[2]`` is not deep enough. Walk by structure instead.
    """
    for candidate in (variant_dir, *variant_dir.parents):
        if (candidate / "packages" / "os" / "linux" / "elizaos").is_dir():
            return candidate
    return variant_dir


DEFAULT_CHIP_REPORT = (
    _repo_root_from_variant(VARIANT_DIR) / "packages/chip/build/reports/qemu_virt_smoke.json"
)
REPO_ROOT = _repo_root_from_variant(VARIANT_DIR)

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
    "iso_boot_artifacts": (dict,),
    "provenance": (str,),
}

REQUIRED_MARKERS = (
    "Linux version",
    "elizaos-firstboot-ready",
    "elizaos-curl-health-ready",
    "elizaos-agent-ready",
    "elizaos-tui-ready",
)
REQUIRED_ISO_BOOT_ARTIFACTS = (
    "riscv64_removable_uefi_loader",
    "grub_config",
    "riscv64_live_kernel",
    "riscv64_live_initrd",
)
ISO_BOOT_ARTIFACT_PATTERNS = {
    "riscv64_removable_uefi_loader": "*/efi/boot/bootriscv64.efi",
    "grub_config": "*/boot/grub/grub.cfg",
    "riscv64_live_kernel": "*/live/vmlinux-*riscv64",
    "riscv64_live_initrd": "*/live/initrd.img-*riscv64",
}


def _prepend_path(path: Path) -> None:
    current = os.environ.get("PATH", "")
    text = str(path)
    parts = current.split(os.pathsep) if current else []
    if text not in parts:
        os.environ["PATH"] = text if not current else os.pathsep.join([text, current])


def _repo_qemu_candidates() -> tuple[Path, ...]:
    return (
        REPO_ROOT / "packages/chip/tools/bin/qemu-system-riscv64",
        REPO_ROOT / "packages/chip/external/qemu-build/bin/qemu-system-riscv64",
        REPO_ROOT
        / "packages/chip/external/xpack-qemu-riscv-9.2.4-1/bin/qemu-system-riscv64",
    )


def _ensure_qemu_on_path() -> str | None:
    for candidate in _repo_qemu_candidates():
        if candidate.is_file() and os.access(candidate, os.X_OK):
            _prepend_path(candidate.parent)
            return str(candidate)
    found = shutil.which("qemu-system-riscv64")
    if found:
        return found
    return None


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


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_iso_boot_artifacts(iso_path: Path) -> dict[str, Any]:
    """List RISC-V UEFI/GRUB artifacts inside an ISO using local host tools."""
    import fnmatch

    commands: list[list[str]] = []
    if shutil.which("isoinfo"):
        commands.extend(
            [
                ["isoinfo", "-R", "-f", "-i", str(iso_path)],
                ["isoinfo", "-f", "-i", str(iso_path)],
            ]
        )
    if shutil.which("bsdtar"):
        commands.append(["bsdtar", "-tf", str(iso_path)])
    if not commands:
        raise EvidenceValidationError(
            "isoinfo or bsdtar is required to inspect riscv64 ISO boot artifacts"
        )
    errors: list[str] = []
    paths: list[str] = []
    for command in commands:
        proc = subprocess.run(command, text=True, capture_output=True, check=False)
        if proc.returncode == 0 and proc.stdout.strip():
            paths = [
                "/" + line.strip().lstrip("/")
                for line in proc.stdout.splitlines()
                if line.strip()
            ]
            break
        errors.append(proc.stderr.strip() or f"{command!r} returned {proc.returncode}")
    if not paths:
        raise EvidenceValidationError(
            "could not list ISO contents while inspecting boot artifacts: "
            + " | ".join(errors)
        )
    lower_paths = [path.lower() for path in paths]
    found: dict[str, str] = {}
    missing: list[str] = []
    for key, pattern in ISO_BOOT_ARTIFACT_PATTERNS.items():
        match = next(
            (
                paths[index]
                for index, path in enumerate(lower_paths)
                if fnmatch.fnmatch(path, pattern)
            ),
            None,
        )
        if match is None:
            missing.append(key)
        else:
            found[key] = match
    return {"found": found, "missing": missing}


def _resolve_evidence_path(path_value: str, evidence_path: Path) -> Path:
    if path_value.startswith("<repo>/"):
        return (REPO_ROOT / path_value.removeprefix("<repo>/")).resolve()
    path = Path(path_value)
    if path.is_absolute():
        return path
    bases = (evidence_path.parent, VARIANT_DIR)
    for base in bases:
        candidate = base / path
        if candidate.exists():
            return candidate
    return VARIANT_DIR / path


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
    iso_boot_artifacts = doc["iso_boot_artifacts"]
    found = iso_boot_artifacts.get("found")
    missing_artifacts = iso_boot_artifacts.get("missing")
    if not isinstance(found, dict):
        raise EvidenceValidationError("iso_boot_artifacts.found must be an object")
    if not isinstance(missing_artifacts, list):
        raise EvidenceValidationError("iso_boot_artifacts.missing must be a list")
    _validate_string_list("iso_boot_artifacts.missing", missing_artifacts)
    for key in REQUIRED_ISO_BOOT_ARTIFACTS:
        value = found.get(key)
        if key not in missing_artifacts and not isinstance(value, str):
            raise EvidenceValidationError(
                f"iso_boot_artifacts.found missing required string key: {key}"
            )


def validate_completed_existing_evidence(doc: dict[str, Any], evidence_path: Path) -> None:
    validate_evidence(doc)
    if not doc["boot_completed"]:
        raise EvidenceValidationError(
            "existing evidence has boot_completed=false "
            f"markers_missing={doc['markers_missing']} "
            f"forbidden_markers_present={doc['forbidden_markers_present']}"
        )
    missing_markers = [marker for marker in REQUIRED_MARKERS if marker not in doc["markers_found"]]
    if missing_markers:
        raise EvidenceValidationError(f"existing evidence missing required markers: {missing_markers}")
    if doc["markers_missing"]:
        raise EvidenceValidationError(f"existing evidence markers_missing is nonempty: {doc['markers_missing']}")
    if doc["forbidden_markers_present"]:
        raise EvidenceValidationError(
            f"existing evidence has forbidden markers: {doc['forbidden_markers_present']}"
        )

    iso_path = _resolve_evidence_path(doc["iso_path"], evidence_path)
    if not iso_path.is_file():
        raise EvidenceValidationError(f"existing evidence ISO path is missing: {iso_path}")
    if _sha256_file(iso_path) != doc["iso_sha256"]:
        raise EvidenceValidationError(f"existing evidence ISO sha256 mismatch: {iso_path}")

    transcript_path = _resolve_evidence_path(doc["transcript_path"], evidence_path)
    if not transcript_path.is_file():
        raise EvidenceValidationError(
            f"existing evidence transcript path is missing: {transcript_path}"
        )
    if _sha256_file(transcript_path) != doc["transcript_sha256"]:
        raise EvidenceValidationError(
            f"existing evidence transcript sha256 mismatch: {transcript_path}"
        )

    if doc["boot_completed"]:
        if doc["forbidden_markers_present"]:
            raise EvidenceValidationError(
                "boot_completed=true but forbidden_markers_present is non-empty"
            )
        missing_artifacts = doc["iso_boot_artifacts"].get("missing", [])
        if missing_artifacts:
            raise EvidenceValidationError(
                "boot_completed=true but ISO boot artifacts are missing: "
                f"{missing_artifacts}"
            )
        for marker in REQUIRED_MARKERS:
            if marker not in doc["markers_found"]:
                raise EvidenceValidationError(
                    f"boot_completed=true but required marker missing: {marker!r}"
                )


def refresh_evidence_markers_from_transcript(doc: dict[str, Any], evidence_path: Path) -> dict[str, Any]:
    """Recompute marker lists and transcript hash from the captured transcript."""
    iso_path = _resolve_evidence_path(str(doc.get("iso_path", "")), evidence_path)
    if not iso_path.is_file():
        raise EvidenceValidationError(f"existing evidence ISO path is missing: {iso_path}")
    try:
        iso_boot_artifacts = inspect_iso_boot_artifacts(iso_path)
    except EvidenceValidationError:
        if not isinstance(doc.get("iso_boot_artifacts"), dict):
            raise
        iso_boot_artifacts = doc["iso_boot_artifacts"]
    doc = {**doc, "iso_boot_artifacts": iso_boot_artifacts}
    validate_evidence(doc)
    transcript_path = _resolve_evidence_path(doc["transcript_path"], evidence_path)
    if not transcript_path.is_file():
        raise EvidenceValidationError(
            f"existing evidence transcript path is missing: {transcript_path}"
        )
    transcript = transcript_path.read_text(encoding="utf-8", errors="replace")
    refreshed = dict(doc)
    markers_found = [marker for marker in REQUIRED_MARKERS if marker in transcript]
    refreshed["markers_found"] = markers_found
    refreshed["markers_missing"] = [
        marker for marker in REQUIRED_MARKERS if marker not in markers_found
    ]
    forbidden = (
        "Kernel panic",
        "Oops",
        "BUG",
        "unhandled signal 4",
        "Illegal instruction",
    )
    refreshed["forbidden_markers_present"] = [
        marker for marker in forbidden if marker in transcript
    ]
    refreshed["transcript_sha256"] = _sha256_file(transcript_path)
    refreshed["boot_completed"] = (
        not refreshed["forbidden_markers_present"]
        and not refreshed["iso_boot_artifacts"].get("missing", [])
        and all(marker in markers_found for marker in REQUIRED_MARKERS)
    )
    validate_evidence(refreshed)
    return refreshed


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

    return subprocess.run(cmd, text=True, check=False)


def write_report(
    output: Path,
    *,
    status: str,
    message: str,
    evidence_path: Path,
    iso: Path | None,
    findings: list[dict[str, Any]] | None = None,
    evidence: dict[str, Any] | None = None,
) -> None:
    report = {
        "schema": "eliza.os_rv64_qemu_virt_smoke.v1",
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "generated_utc": datetime.now(UTC).isoformat(),
        "message": message,
        "iso_path": str(iso) if iso is not None else "",
        "evidence_path": str(evidence_path),
        "required_markers": list(REQUIRED_MARKERS),
        "findings": findings or [],
        "evidence": evidence or {},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def finding(code: str, message: str, next_step: str) -> dict[str, Any]:
    return {
        "code": code,
        "severity": "blocker",
        "message": message,
        "evidence": "python3 packages/os/linux/elizaos/scripts/qemu_virt_smoke.py",
        "next_step": next_step,
    }


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run qemu_virt_boot.sh and validate the evidence JSON.",
    )
    parser.add_argument(
        "--iso",
        type=Path,
        default=None,
        help="path to live ISO; if omitted, the newest riscv64 ISO under out/ is used",
    )
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
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_CHIP_REPORT,
        help="structured report mirror for chip OS boot inventory",
    )
    parser.add_argument(
        "--validate-existing",
        action="store_true",
        help=(
            "Validate --evidence and refresh --report without launching QEMU. "
            "Fails unless the evidence proves a completed boot and artifact hashes match."
        ),
    )
    parser.add_argument(
        "--refresh-existing",
        action="store_true",
        help=(
            "Recompute marker fields and transcript_sha256 from --transcript/recorded "
            "transcript without launching QEMU, then refresh --evidence and --report."
        ),
    )
    return parser.parse_args(argv)


def _resolve_iso(explicit: Path | None) -> Path | None:
    """Pick the ISO to boot: an explicit ``--iso``, else the newest riscv64 ISO
    built under ``out/``. Returns ``None`` when nothing has been built yet so the
    caller can report a fail-closed BLOCKED state instead of crashing."""
    if explicit is not None:
        return explicit
    out_dir = VARIANT_DIR / "out"
    if not out_dir.is_dir():
        return None
    candidates = sorted(
        out_dir.glob("*riscv64*.iso"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.refresh_existing:
        doc: dict[str, Any] | None = None
        try:
            doc = load_evidence(args.evidence)
            if args.transcript != VARIANT_DIR / "evidence" / "qemu_virt_boot.transcript.log":
                doc = {**doc, "transcript_path": str(args.transcript)}
            doc = refresh_evidence_markers_from_transcript(doc, args.evidence)
            args.evidence.write_text(
                json.dumps(doc, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        except (FileNotFoundError, EvidenceValidationError) as exc:
            message = f"qemu_virt_smoke: ERROR: {exc}"
            write_report(
                args.report,
                status="blocked",
                message=message,
                evidence_path=args.evidence,
                iso=None,
                findings=[
                    finding(
                        "os_rv64_qemu_virt_existing_evidence_invalid",
                        message,
                        "Rerun qemu_virt_smoke.py without --refresh-existing to capture fresh boot evidence.",
                    )
                ],
                evidence=doc if isinstance(doc, dict) else None,
            )
            print(message, file=sys.stderr)
            return 2
        status = "pass" if doc["boot_completed"] else "blocked"
        message = (
            "qemu_virt_smoke: PASS existing evidence refreshed"
            if status == "pass"
            else "qemu_virt_smoke: BLOCKED existing evidence refreshed; "
            f"markers_missing={doc['markers_missing']} "
            f"forbidden_markers_present={doc['forbidden_markers_present']}"
        )
        findings = None
        if status == "blocked":
            findings = [
                finding(
                    "os_rv64_qemu_virt_boot_incomplete",
                    message,
                    "Rebuild/recapture qemu-virt evidence after fixing the missing runtime markers.",
                )
            ]
        write_report(
            args.report,
            status=status,
            message=message,
            evidence_path=args.evidence,
            iso=Path(doc["iso_path"]),
            evidence=doc,
            findings=findings,
        )
        print(message)
        return 0 if status == "pass" else 2

    if args.validate_existing:
        doc: dict[str, Any] | None = None
        try:
            doc = load_evidence(args.evidence)
            validate_completed_existing_evidence(doc, args.evidence)
        except (FileNotFoundError, EvidenceValidationError) as exc:
            message = f"qemu_virt_smoke: ERROR: {exc}"
            write_report(
                args.report,
                status="blocked",
                message=message,
                evidence_path=args.evidence,
                iso=None,
                findings=[
                    finding(
                        "os_rv64_qemu_virt_existing_evidence_invalid",
                        message,
                        "Rerun qemu_virt_smoke.py without --validate-existing to capture fresh boot evidence.",
                    )
                ],
                evidence=doc if isinstance(doc, dict) else None,
            )
            print(message, file=sys.stderr)
            return 2
        write_report(
            args.report,
            status="pass",
            message="qemu_virt_smoke: PASS existing evidence validated",
            evidence_path=args.evidence,
            iso=Path(doc["iso_path"]),
            evidence=doc,
        )
        print(
            f"qemu_virt_smoke: PASS existing evidence validated: "
            f"evidence={args.evidence} duration_s={doc['duration_s']}"
        )
        return 0

    iso = _resolve_iso(args.iso)
    if iso is None:
        message = (
            "STATUS: BLOCKED os_rv64.qemu_virt_smoke - no riscv64 elizaOS live ISO "
            "built under packages/os/linux/elizaos/out/; build it with "
            "`cd packages/os/linux/elizaos && ./build.sh ARCH=riscv64` (or the "
            "Makefile build target) then re-run with --iso <path>."
        )
        write_report(
            args.report,
            status="blocked",
            message=message,
            evidence_path=args.evidence,
            iso=None,
            findings=[
                finding(
                    "os_rv64_qemu_virt_iso_missing",
                    "no riscv64 elizaOS live ISO built under packages/os/linux/elizaos/out/",
                    "Build the riscv64 live ISO or pass --iso with the exact artifact path.",
                )
            ],
        )
        print(message)
        return 2
    args.iso = iso

    if not args.iso.is_file():
        message = f"qemu_virt_smoke: ERROR: ISO not found: {args.iso}"
        write_report(
            args.report,
            status="blocked",
            message=message,
            evidence_path=args.evidence,
            iso=args.iso,
            findings=[
                finding(
                    "os_rv64_qemu_virt_iso_path_missing",
                    message,
                    "Pass --iso with an existing riscv64 elizaOS live ISO.",
                )
            ],
        )
        print(message, file=sys.stderr)
        return 2

    qemu = _ensure_qemu_on_path()
    if qemu is None:
        message = (
            "STATUS: BLOCKED os_rv64.qemu_virt_smoke - qemu-system-riscv64 not on PATH; "
            "source packages/chip/tools/env.sh (native oss-cad-suite), install a riscv64 "
            "QEMU system emulator, or stage one at packages/chip/tools/bin/qemu-system-riscv64."
        )
        write_report(
            args.report,
            status="blocked",
            message=message,
            evidence_path=args.evidence,
            iso=args.iso,
            findings=[
                finding(
                    "os_rv64_qemu_system_riscv64_missing",
                    "qemu-system-riscv64 is not on PATH and no repo-local QEMU candidate is executable",
                    "Source packages/chip/tools/env.sh, install a riscv64 QEMU system emulator, or stage one under packages/chip/tools/bin.",
                )
            ],
        )
        print(message)
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
        message = f"qemu_virt_smoke: ERROR: {exc}"
        write_report(
            args.report,
            status="blocked",
            message=message,
            evidence_path=args.evidence,
            iso=args.iso,
            findings=[
                finding(
                    "os_rv64_qemu_virt_evidence_invalid",
                    message,
                    "Regenerate valid qemu virt boot evidence from the harness.",
                )
            ],
        )
        print(message, file=sys.stderr)
        return 2

    if not doc["boot_completed"]:
        message = (
            "qemu_virt_smoke: FAIL: boot_completed=false; "
            f"markers_missing={doc['markers_missing']} "
            f"forbidden_markers_present={doc['forbidden_markers_present']}"
        )
        write_report(
            args.report,
            status="fail",
            message=message,
            evidence_path=args.evidence,
            iso=args.iso,
            findings=[
                {
                    "code": "os_rv64_qemu_virt_boot_incomplete",
                    "severity": "fail",
                    "message": message,
                    "evidence": str(args.evidence),
                    "next_step": "Debug the QEMU transcript until all required boot and Eliza readiness markers appear.",
                }
            ],
            evidence=doc,
        )
        print(message, file=sys.stderr)
        return 1

    write_report(
        args.report,
        status="pass",
        message="qemu_virt_smoke: PASS",
        evidence_path=args.evidence,
        iso=args.iso,
        evidence=doc,
    )
    print(
        f"qemu_virt_smoke: PASS: evidence={args.evidence} "
        f"duration_s={doc['duration_s']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
