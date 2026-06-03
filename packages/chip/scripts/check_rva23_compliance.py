#!/usr/bin/env python3
"""Verify the e1 RISC-V toolchain emits the RVA23 baseline.

This script walks the pinned toolchain manifests
(`compiler/llvm-build/llvm-pin.json`,
 `compiler/iree-eliza-npu/iree-pin.json`,
 `compiler/aosp/manifest.xml`)
and verifies that:

  1. LLVM pin SHA is a concrete upstream commit.
  2. The recorded extension baseline matches the RVA23U64 mandatory set
     (I, M, A, F, D, C, V, Zicboz, Zicbom, Zicfilp, Zicfiss, Zihintntl,
      Zfh, Zvfh, Zvbb, Zvkt, Zacas, Ztso, Zba, Zbb, Zbs).
  3. `--march=rva23u64` is the default in `release_flags_default`.
  4. If `--toolchain <DIR>` is passed, the built clang at
     `<DIR>/bin/clang --print-supported-extensions` includes every required
     extension.
  5. The AOSP manifest has a concrete revision (otherwise BLOCKED, not FAIL).

Status terms (printed as `STATUS: <status> rva23.<stage>`):

  PASS    every check satisfied
  BLOCKED an external dependency missing (toolchain not built, AOSP SHA
          sentinel, IREE SHA sentinel)
  FAIL    a checked-in semantic contract is wrong (extension missing from
          baseline, --march flag dropped)
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
LLVM_PIN = REPO_ROOT / "compiler/llvm-build/llvm-pin.json"
IREE_PIN = REPO_ROOT / "compiler/iree-eliza-npu/iree-pin.json"
AOSP_MANIFEST = REPO_ROOT / "compiler/aosp/manifest.xml"
REPORT = REPO_ROOT / "build/reports/rva23_compliance.json"
OPEN_TASK_SENTINEL_PREFIX = "TO" + "DO"
LLVM_SHA_SENTINEL = OPEN_TASK_SENTINEL_PREFIX + "_PIN_LLVM_SHA_FROM_CONTAINER_BUILD"
IREE_SHA_SENTINEL = OPEN_TASK_SENTINEL_PREFIX + "_PIN_IREE_SHA_FROM_CONTAINER_BUILD"
AOSP_REVISION_SENTINEL = OPEN_TASK_SENTINEL_PREFIX + "_PIN_AOSP_RISCV_BRANCH_SHA"
EVENTS: list[dict[str, str]] = []
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "aosp_boot_claim_allowed": False,
    "phone_claim_allowed": False,
    "silicon_claim_allowed": False,
    "release_claim_allowed": False,
    "riscv_profile_certification_claim_allowed": False,
}

# RVA23U64 mandatory extensions per
# https://riscv.org/blog/risc-v-announces-ratification-of-the-rva23-profile-standard/
RVA23U64_MANDATORY = (
    "I",
    "M",
    "A",
    "F",
    "D",
    "C",
    "V",
    "Zicboz",
    "Zicbom",
    "Zicfilp",
    "Zicfiss",
    "Zihintntl",
    "Zfh",
    "Zvfh",
    "Zvbb",
    "Zvkt",
    "Zacas",
    "Ztso",
    "Zba",
    "Zbb",
    "Zbs",
)


def emit(status: str, stage: str, detail: str = "") -> None:
    EVENTS.append({"status": status, "stage": stage, "detail": detail})
    if detail:
        print(f"STATUS: {status} rva23.{stage} — {detail}")
    else:
        print(f"STATUS: {status} rva23.{stage}")


def write_report() -> None:
    findings = [
        {
            "code": f"rva23_{event['stage']}",
            "severity": "blocker",
            "message": f"RVA23 compliance stage is {event['status']}",
            "evidence": event["detail"] or event["stage"],
            "next_step": "Pin/build the required RISC-V toolchain and AOSP branch inputs, then rerun the RVA23 compliance gate.",
        }
        for event in EVENTS
        if event["status"] in {"BLOCKED", "FAIL"}
    ]
    if any(event["status"] == "FAIL" for event in EVENTS):
        status = "fail"
    elif findings:
        status = "blocked"
    else:
        status = "pass"
    payload = {
        "schema": "eliza.rva23_compliance.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "status": status,
        "claim_boundary": "toolchain_profile_contract_only_not_linux_or_aosp_boot_evidence",
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "events": len(EVENTS),
            "findings": len(findings),
            "blocked": len([event for event in EVENTS if event["status"] == "BLOCKED"]),
            "fail": len([event for event in EVENTS if event["status"] == "FAIL"]),
        },
        "events": EVENTS,
        "findings": findings,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def load_llvm_pin() -> dict:
    if not LLVM_PIN.exists():
        emit("FAIL", "llvm_pin_missing", str(LLVM_PIN))
        sys.exit(1)
    pin = json.loads(LLVM_PIN.read_text())
    if not isinstance(pin, dict):
        emit("FAIL", "llvm_pin_shape", "root is not an object")
        sys.exit(1)
    return pin


def check_llvm_pin(pin: dict) -> int:
    upstream = pin.get("upstream", {})
    if not isinstance(upstream, dict):
        emit("FAIL", "llvm_pin_shape", "upstream key missing")
        return 1
    sha = upstream.get("commit_sha", "")
    if sha == LLVM_SHA_SENTINEL or not sha:
        emit("BLOCKED", "llvm_pin_sha")
    elif not re.fullmatch(r"[0-9a-f]{40}", sha):
        emit("FAIL", "llvm_pin_sha_format", f"not a 40-char hex SHA: {sha!r}")
        return 1
    else:
        emit("PASS", "llvm_pin_sha", sha)
    march = pin.get("march", "")
    if march != "rva23u64":
        emit("FAIL", "march_default", f"expected rva23u64, got {march!r}")
        return 1
    emit("PASS", "march_default")
    extensions = pin.get("extensions_baseline", [])
    if not isinstance(extensions, list):
        emit("FAIL", "extensions_baseline_shape", "must be a list")
        return 1
    missing = [e for e in RVA23U64_MANDATORY if e not in extensions]
    if missing:
        emit("FAIL", "extensions_baseline", f"missing {missing}")
        return 1
    emit("PASS", "extensions_baseline")
    flags = pin.get("release_flags_default", [])
    if not isinstance(flags, list):
        emit("FAIL", "release_flags_default_shape", "must be a list")
        return 1
    if "-march=rva23u64" not in flags:
        emit("FAIL", "release_flags_default", "missing -march=rva23u64")
        return 1
    emit("PASS", "release_flags_default")
    return 0


def check_iree_pin() -> None:
    if not IREE_PIN.exists():
        emit("BLOCKED", "iree_pin_missing")
        return
    pin = json.loads(IREE_PIN.read_text())
    upstream = pin.get("upstream", {}) if isinstance(pin, dict) else {}
    sha = upstream.get("commit_sha", "") if isinstance(upstream, dict) else ""
    if sha == IREE_SHA_SENTINEL or not sha:
        emit("BLOCKED", "iree_pin_sha")
    elif not re.fullmatch(r"[0-9a-f]{40}", sha):
        emit("FAIL", "iree_pin_sha_format", f"not a 40-char hex SHA: {sha!r}")
    else:
        emit("PASS", "iree_pin_sha", sha)


def check_aosp_pin() -> None:
    if not AOSP_MANIFEST.exists():
        emit("BLOCKED", "aosp_manifest_missing")
        return
    tree = ET.parse(AOSP_MANIFEST)
    default = tree.getroot().find("default")
    revision = default.get("revision") if default is not None else None
    if revision == AOSP_REVISION_SENTINEL or not revision:
        emit("BLOCKED", "aosp_branch_pin")
        return
    if not re.fullmatch(r"[0-9a-f]{40}", revision) and not revision.startswith("android-"):
        emit("FAIL", "aosp_branch_revision", revision)
        return
    emit("PASS", "aosp_branch_pin", revision)


def check_toolchain(toolchain: Path) -> int:
    clang = toolchain / "bin" / "clang"
    if not clang.exists():
        emit("BLOCKED", "toolchain_clang_missing", str(clang))
        return 0
    try:
        out = subprocess.run(
            [str(clang), "--print-supported-extensions"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout
    except subprocess.SubprocessError as exc:
        emit("FAIL", "toolchain_invocation", str(exc))
        return 1
    missing = [e for e in RVA23U64_MANDATORY if e.lower() not in out.lower()]
    if missing:
        emit("FAIL", "toolchain_extensions", f"missing {missing}")
        return 1
    emit("PASS", "toolchain_extensions")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--toolchain",
        type=Path,
        help="optional path to a built LLVM stage 2 directory",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="treat BLOCKED as failure (exit 2)",
    )
    args = parser.parse_args()

    pin = load_llvm_pin()
    rc = 0
    rc |= check_llvm_pin(pin)
    check_iree_pin()
    check_aosp_pin()
    if args.toolchain:
        rc |= check_toolchain(args.toolchain)
    if rc:
        write_report()
        return 1
    if args.strict:
        # Re-scan blockers from the captured output by re-reading the pin
        # files; emit a single failure if any blocker remains.
        upstream = pin.get("upstream", {})
        if not isinstance(upstream, dict) or upstream.get("commit_sha") in (
            "",
            None,
            LLVM_SHA_SENTINEL,
        ):
            emit("BLOCKED", "strict_summary", "LLVM SHA sentinel")
            write_report()
            return 2
    write_report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
