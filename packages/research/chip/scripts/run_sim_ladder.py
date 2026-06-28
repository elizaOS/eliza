#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/sim_ladder.json"
CLAIM_BOUNDARY = "local_rtl_simulation_ladder_only_not_linux_or_android_chip_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "chip_boot_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

LADDER = [
    {
        "name": "cocotb_top",
        "command": ["make", "cocotb"],
        "required_artifacts": ["build/reports/cocotb/e1_chip_top_test_e1_chip.xml"],
    },
    {
        "name": "cocotb_contract",
        "command": ["make", "cocotb-contract"],
        "required_artifacts": [
            "build/reports/cocotb/e1_linux_soc_contract_test_cpu_mem_intc_contract.xml"
        ],
    },
    {
        "name": "cocotb_npu",
        "command": ["make", "cocotb-npu"],
        "required_artifacts": ["build/reports/cocotb/e1_npu_test_e1_npu.xml"],
    },
    {
        "name": "cocotb_cpu",
        "command": ["make", "cocotb-cpu"],
        "required_artifacts": [
            "build/reports/cocotb/e1_tiny_cpu_contract_tb_test_tiny_cpu_execution.xml"
        ],
    },
    {
        "name": "verilator_smoke",
        "command": ["make", "verilator"],
        "required_artifacts": ["build/verilator/Ve1_chip_top"],
    },
]


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def provenance_safe_text(value: str) -> str:
    safe = value.replace(str(ROOT), "<repo>")
    home = os.environ.get("HOME")
    if home:
        safe = safe.replace(home, "<home>")
    safe = safe.replace("/var/tmp/", "<var-tmp>/")
    safe = safe.replace("/tmp/", "<tmp>/")
    return safe


def provenance_safe_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: provenance_safe_value(child) for key, child in value.items()}
    if isinstance(value, list):
        return [provenance_safe_value(child) for child in value]
    if isinstance(value, str):
        return provenance_safe_text(value)
    return value


def structured_findings(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for item in results:
        status = str(item.get("status", "unknown"))
        if status == "pass":
            continue
        name = str(item.get("name", "sim_step"))
        missing = item.get("missing_artifacts")
        evidence = {
            "step": name,
            "status": status,
            "command": item.get("command"),
            "returncode": item.get("returncode"),
            "missing_artifacts": missing if isinstance(missing, list) else [],
            "log_tail": item.get("log_tail", [])[-10:]
            if isinstance(item.get("log_tail"), list)
            else [],
        }
        findings.append(
            {
                "code": f"sim_ladder_step_{code_from_text(status, 'status')}_{code_from_text(name, 'step')}",
                "severity": "blocker" if status == "blocked" else "failure",
                "message": f"simulation ladder step {name} is {status}",
                "evidence": evidence,
                "next_step": (
                    "Repair the local RTL simulation dependency, failing test, "
                    "or missing artifact, then rerun the ladder before treating "
                    "local RTL simulation as chip-emulator bring-up evidence."
                ),
            }
        )
        missing_list = missing if isinstance(missing, list) else []
        for artifact in missing_list:
            findings.append(
                {
                    "code": (
                        "sim_ladder_missing_artifact_"
                        f"{code_from_text(name + '_' + str(artifact), 'artifact')}"
                    ),
                    "severity": "blocker",
                    "message": f"simulation ladder step {name} did not produce {artifact}",
                    "evidence": artifact,
                    "next_step": (
                        "Regenerate the required simulation artifact and keep it "
                        "fresh against the ladder step before using this report "
                        "as RTL simulation evidence."
                    ),
                }
            )
        break
    return findings


def run_step(step: dict[str, Any]) -> dict[str, Any]:
    command = step["command"]
    assert isinstance(command, list)
    start = time.time()
    result = subprocess.run(
        command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    elapsed = round(time.time() - start, 3)
    artifacts = step.get("required_artifacts", [])
    if not isinstance(artifacts, list):
        artifacts = []
    missing = [
        artifact
        for artifact in artifacts
        if isinstance(artifact, str) and not (ROOT / artifact).exists()
    ]
    output = result.stdout
    blocked_markers = (
        "cocotb is not installed",
        "No cocotb simulator found",
        "verilator: not found",
        "No such file or directory",
    )
    if result.returncode == 0 and not missing:
        status = "pass"
    elif any(marker in output for marker in blocked_markers):
        status = "blocked"
    else:
        status = "fail"
    log_tail = [] if status == "pass" else result.stdout.splitlines()[-40:]
    return {
        "name": step["name"],
        "command": command,
        "status": status,
        "returncode": result.returncode,
        "elapsed_seconds": elapsed,
        "required_artifacts": artifacts,
        "missing_artifacts": missing,
        "log_tail": log_tail,
    }


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for step in LADDER:
        result = run_step(step)
        results.append(result)
        if result["status"] != "pass":
            break

    manifest = {
        "schema": "eliza.sim_ladder.v1",
        "generated_utc": utc_now(),
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "status": "pass"
        if all(item["status"] == "pass" for item in results) and len(results) == len(LADDER)
        else "fail",
        "results": results,
    }
    manifest["findings"] = structured_findings(results)
    output_manifest = provenance_safe_value(manifest)
    tmp = REPORT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(output_manifest, indent=2, sort_keys=True) + "\n")
    tmp.replace(REPORT)

    if manifest["status"] != "pass":
        has_failure = any(item["status"] == "fail" for item in results)
        label = "failed" if has_failure else "blocked"
        print(f"Simulation ladder {label}; wrote {REPORT.relative_to(ROOT)}")
        for item in results:
            print(f"  - {item['name']}: {item['status']}")
            if item["status"] != "pass":
                log_tail = item.get("log_tail", [])
                if not isinstance(log_tail, list):
                    log_tail = []
                for line in log_tail[-10:]:
                    print(f"    {line}")
                break
        if has_failure:
            return 1
        print("STATUS: BLOCKED sim_ladder - missing local RTL simulation dependency")
        return 2

    print(f"Simulation ladder passed; wrote {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
