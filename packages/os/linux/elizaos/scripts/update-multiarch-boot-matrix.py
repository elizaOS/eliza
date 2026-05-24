#!/usr/bin/env python3
"""Promote or refresh riscv64 boot evidence in the multi-arch boot matrix."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "evidence/multiarch_boot_matrix.json"
QEMU_SMOKE = ROOT / "scripts/qemu_virt_smoke.py"

RISCV64_PROOFS = (
    "Debian live ISO boots under qemu-system-riscv64 -M virt through EDK2/OpenSBI",
    "GRUB EFI path is visible in transcript",
    "ISO contains Debian riscv64 GRUB EFI boot artifacts",
    "kernel serial transcript includes Linux version",
    "first boot completed",
    "guest-side curl reached http://127.0.0.1:31337/api/health",
    "agent readiness marker reported",
    "terminal TUI smoke marker reported",
)
NON_PRODUCTION_GAPS = (
    "not E1 chip/AP target evidence",
    "not physical silicon evidence",
)
RISCV64_BUN_PROVENANCE = ROOT / "artifacts/riscv64/riscv64-bun-provenance.json"
RISCV64_BLOCKED_GAP = (
    "current riscv64 ISO reaches Linux under repo-pinned QEMU, but agent "
    "health and TUI readiness remain blocked; rebuild from the current staged "
    "runtime artifacts and recapture before candidate promotion"
)


def _load_qemu_smoke_module() -> Any:
    spec = importlib.util.spec_from_file_location("qemu_virt_smoke", QEMU_SMOKE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {QEMU_SMOKE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


def _read_evidence_document(evidence_path: Path, allow_blocked: bool = False) -> dict[str, Any]:
    raw = json.loads(evidence_path.read_text(encoding="utf-8"))
    if raw.get("schema") == "eliza.os_rv64_qemu_virt_smoke.v1":
        if raw.get("status") != "pass" and not allow_blocked:
            raise ValueError(f"qemu virt smoke report is not pass: {raw.get('status')}")
        evidence = raw.get("evidence")
        if not isinstance(evidence, dict):
            raise ValueError("qemu virt smoke report has no nested evidence object")
        return evidence
    return raw


def validate_riscv64_evidence(
    evidence_path: Path, iso_override: Path | None = None, allow_blocked: bool = False
) -> dict[str, Any]:
    qemu_smoke = _load_qemu_smoke_module()
    evidence = _read_evidence_document(evidence_path, allow_blocked=allow_blocked)
    qemu_smoke.validate_evidence(evidence)
    if not allow_blocked and not evidence.get("boot_completed"):
        raise ValueError(f"boot evidence is incomplete: {evidence_path}")
    iso_path = (
        iso_override
        if iso_override is not None
        else Path(str(evidence.get("iso_path", "")))
    )
    if not iso_path.is_absolute():
        iso_path = (evidence_path.parent / iso_path).resolve()
    if not iso_path.is_file():
        raise FileNotFoundError(f"boot evidence ISO path is missing: {iso_path}")
    actual_iso_sha = sha256_file(iso_path)
    if evidence.get("iso_sha256") != actual_iso_sha:
        raise ValueError(
            "boot evidence iso_sha256 does not match ISO on disk: "
            f"{evidence.get('iso_sha256')} != {actual_iso_sha}"
        )
    evidence["iso_path"] = str(iso_path)
    return evidence


def _runtime_artifacts_for_current_stage(row: dict[str, Any]) -> dict[str, Any]:
    runtime_artifacts = row.get("runtime_artifacts")
    if not isinstance(runtime_artifacts, dict):
        runtime_artifacts = {}
    staged_node_bundle = ROOT / "artifacts/riscv64/elizaos-app/agent-bundle.js"
    staged_bun = ROOT / "artifacts/riscv64/bun"
    if staged_node_bundle.is_file() and not staged_bun.exists():
        runtime_artifacts.pop("bun", None)
        runtime_artifacts.pop("bun_sha256", None)
        runtime_artifacts.pop("riscv64_bun_provenance", None)
        runtime_artifacts["runtime_mode"] = "node"
        runtime_artifacts["agent_bundle"] = "artifacts/riscv64/elizaos-app"
        runtime_artifacts["riscv64_agent_runtime_smoke"] = (
            "evidence/riscv64_agent_runtime_smoke.json"
        )
    return runtime_artifacts


def promote_riscv64(
    matrix: dict[str, Any], evidence_path: Path, evidence: dict[str, Any]
) -> dict[str, Any]:
    rows = matrix.get("architectures")
    if not isinstance(rows, list):
        raise ValueError("matrix architectures field must be a list")
    row = next(
        (
            candidate
            for candidate in rows
            if isinstance(candidate, dict) and candidate.get("arch") == "riscv64"
        ),
        None,
    )
    if row is None:
        raise ValueError("matrix is missing riscv64 row")

    iso_path = Path(str(evidence["iso_path"]))
    if not iso_path.is_absolute():
        iso_path = (evidence_path.parent / iso_path).resolve()

    row["status"] = "candidate"
    row["iso"] = rel(iso_path)
    row["sha256"] = str(evidence["iso_sha256"])
    row["evidence"] = rel(evidence_path)
    row["proves"] = list(RISCV64_PROOFS)
    row["gaps"] = list(NON_PRODUCTION_GAPS)
    runtime_artifacts = _runtime_artifacts_for_current_stage(row)
    provenance = RISCV64_BUN_PROVENANCE
    if provenance.is_file():
        runtime_artifacts["riscv64_bun_provenance"] = rel(provenance)
    row["runtime_artifacts"] = runtime_artifacts
    matrix["updated_at"] = (
        datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    return row


def refresh_blocked_riscv64(
    matrix: dict[str, Any], evidence_path: Path, evidence: dict[str, Any]
) -> dict[str, Any]:
    rows = matrix.get("architectures")
    if not isinstance(rows, list):
        raise ValueError("matrix architectures field must be a list")
    row = next(
        (
            candidate
            for candidate in rows
            if isinstance(candidate, dict) and candidate.get("arch") == "riscv64"
        ),
        None,
    )
    if row is None:
        raise ValueError("matrix is missing riscv64 row")

    iso_path = Path(str(evidence["iso_path"]))
    if not iso_path.is_absolute():
        iso_path = (evidence_path.parent / iso_path).resolve()

    row["status"] = "blocked-current-iso-boot"
    row["iso"] = rel(iso_path)
    row["sha256"] = str(evidence["iso_sha256"])
    row["evidence"] = rel(evidence_path)
    markers_found = set(evidence.get("markers_found") or [])
    transcript_text = ""
    transcript_value = evidence.get("transcript_path")
    if isinstance(transcript_value, str) and transcript_value:
        raw_transcript_path = Path(transcript_value)
        candidates = (
            raw_transcript_path,
            evidence_path.parent / raw_transcript_path,
            ROOT / raw_transcript_path,
        )
        for transcript_path in candidates:
            if transcript_path.is_file():
                transcript_text = transcript_path.read_text(
                    encoding="utf-8", errors="replace"
                )
                break
    partial_proofs = [
        "Debian live ISO boots under qemu-system-riscv64 -M virt through EDK2/OpenSBI",
    ]
    if (
        "GNU GRUB" in transcript_text and "EFI stub: Booting Linux Kernel" in transcript_text
    ) or "Linux version" in markers_found:
        partial_proofs.append("GRUB EFI path is visible in transcript")
    if "Linux version" in markers_found:
        partial_proofs.extend(
            [
                "fresh riscv64 ISO enters OpenSBI under repo-pinned qemu-system-riscv64 -M virt",
                "fresh riscv64 ISO enters EDK2 UEFI firmware",
                "fresh riscv64 ISO reaches GRUB EFI menu",
                "fresh riscv64 ISO starts the Linux EFI stub",
                "kernel serial transcript includes Linux version",
            ]
        )
    row["proves"] = partial_proofs
    row["gaps"] = [RISCV64_BLOCKED_GAP, *NON_PRODUCTION_GAPS]
    row["runtime_artifacts"] = _runtime_artifacts_for_current_stage(row)
    matrix["updated_at"] = (
        datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    return row


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", choices=("riscv64",), default="riscv64")
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--iso", type=Path, default=None)
    parser.add_argument("--matrix", type=Path, default=MATRIX)
    parser.add_argument(
        "--allow-blocked",
        action="store_true",
        help="refresh a blocked row from incomplete evidence without promoting it",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    evidence_path = args.evidence.resolve()
    matrix_path = args.matrix.resolve()
    iso_override = args.iso.resolve() if args.iso is not None else None
    evidence = validate_riscv64_evidence(
        evidence_path, iso_override, allow_blocked=args.allow_blocked
    )
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    if evidence.get("boot_completed"):
        row = promote_riscv64(matrix, evidence_path, evidence)
        action = "promoted"
    elif args.allow_blocked:
        row = refresh_blocked_riscv64(matrix, evidence_path, evidence)
        action = "refreshed blocked"
    else:
        raise ValueError(f"boot evidence is incomplete: {evidence_path}")
    if not args.dry_run:
        matrix_path.write_text(
            json.dumps(matrix, indent=2, sort_keys=False) + "\n",
            encoding="utf-8",
        )
    print(
        f"OK: {action} riscv64 boot matrix row "
        f"iso={row['iso']} evidence={row['evidence']} sha256={row['sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
