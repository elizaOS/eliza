#!/usr/bin/env python3
"""Gate real RV64GC/Linux AP completion claims on generated artifacts and boot evidence."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

from cpu_ap_evidence_lib import (
    GENERATED_MANIFEST,
    PLATFORM_CONTRACT,
    ROOT,
    SELECTED_MANIFEST,
    load_evidence_manifest,
    load_json,
    rel,
    transcript_specs,
)


def completion_claimed() -> bool:
    selected = load_json(SELECTED_MANIFEST)
    platform = load_json(PLATFORM_CONTRACT)
    claim_policy = selected.get("claim_policy", {})
    return any(
        (
            selected.get("status") in {"generated", "complete", "linux_complete"},
            claim_policy.get("linux_capable_cpu_claim") is True,
            claim_policy.get("platform_contract_has_cpu_may_flip_to_true") is True,
            platform.get("e1_chip", {}).get("has_cpu") is True,
        )
    )


def run_generated_gate() -> int:
    env = os.environ.copy()
    env["REQUIRE_CHIPYARD_GENERATED"] = "1"
    generated = subprocess.run(
        [sys.executable, "scripts/check_chipyard_generator_manifest.py", "--require-generated"],
        cwd=ROOT,
        env=env,
        check=False,
    )
    if generated.returncode != 0:
        return generated.returncode
    return subprocess.run(
        [sys.executable, "scripts/check_cpu_ap_evidence.py", "--require-evidence"],
        cwd=ROOT,
        check=False,
    ).returncode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()

    claimed = completion_claimed()
    if claimed or args.require_complete:
        rc = run_generated_gate()
        if rc != 0:
            print(
                "STATUS: FAIL cpu_ap.completion_gate - real RV64GC/Linux AP claim is not backed by required artifacts"
            )
            return rc
        print(
            "STATUS: PASS cpu_ap.completion_gate - generated Rocket RV64GC AP artifacts and boot evidence are present"
        )
        return 0

    generated_detail = (
        f"generated manifest present: {rel(GENERATED_MANIFEST)}"
        if GENERATED_MANIFEST.is_file()
        else f"missing generated manifest: {rel(GENERATED_MANIFEST)}"
    )
    print(
        "STATUS: BLOCKED cpu_ap.completion_gate - no real RV64GC/Linux AP completion claim; "
        f"Linux boot evidence is absent or incomplete ({generated_detail})"
    )
    errors: list[str] = []
    evidence_manifest = load_evidence_manifest(errors)
    if not errors:
        missing_logs = []
        next_capture = []
        for spec in transcript_specs(evidence_manifest).values():
            if isinstance(spec.get("path"), str) and not (ROOT / str(spec["path"])).is_file():
                missing_logs.append(str(spec["path"]))
                if isinstance(spec.get("capture_command"), str):
                    next_capture.append(str(spec["capture_command"]))
        if missing_logs:
            print("  missing CPU/AP evidence logs: " + ", ".join(missing_logs))
        if next_capture:
            print("  capture commands:")
            for command in next_capture:
                print(f"    {command}")
    print(
        "  next: python3 scripts/check_chipyard_import_preflight.py --require-checkout && "
        "make chipyard-generated-check cpu-ap-evidence-check cpu-ap-completion-gate"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
