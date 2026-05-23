import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

parser = argparse.ArgumentParser()
parser.add_argument(
    "--release", action="store_true", help="fail on fabrication/tapeout release blockers"
)
parser.add_argument(
    "--json",
    action="store_true",
    help="also print the final machine-readable product status report",
)
args = parser.parse_args()

REPORT = Path("build/reports/product_release_status.json")


def write_report(report: dict) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def emit_json(report: dict) -> None:
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def detail_failure_lines(detail_checks: dict) -> list[dict]:
    rows: list[dict] = []
    for name, detail in detail_checks.items():
        if name == "release_checks" and isinstance(detail, list):
            for check in detail:
                if not isinstance(check, dict):
                    continue
                script = str(check.get("script", "release_check"))
                for stream in ("stdout", "stderr"):
                    for line in str(check.get(stream, "")).splitlines():
                        stripped = line.strip()
                        if stripped.startswith("- "):
                            rows.append(
                                {
                                    "source": script,
                                    "returncode": check.get("returncode"),
                                    "line": stripped[2:],
                                }
                            )
            continue
        if not isinstance(detail, dict):
            continue
        source = name
        command = detail.get("command")
        if isinstance(command, list) and command:
            source = " ".join(str(part) for part in command)
        for stream in ("stdout", "stderr"):
            for line in str(detail.get(stream, "")).splitlines():
                stripped = line.strip()
                if stripped.startswith("- "):
                    rows.append(
                        {
                            "source": source,
                            "returncode": detail.get("returncode"),
                            "line": stripped[2:],
                        }
                    )
    return rows


def structured_findings(release_blockers: list[str], detail_checks: dict) -> list[dict]:
    findings: list[dict] = []
    for blocker in release_blockers:
        findings.append(
            {
                "code": f"product_release_blocker_{code_from_text(blocker, 'blocker')}",
                "severity": "blocker",
                "message": blocker,
                "evidence": "release_blockers",
                "next_step": (
                    "Close the named package, FPGA, KiCad, PD, manufacturing, "
                    "or release-check blocker before making fabrication, tapeout, "
                    "or no-issues product readiness claims."
                ),
            }
        )
    seen: set[str] = set()
    for row in detail_failure_lines(detail_checks):
        line = str(row["line"])
        code = f"product_release_detail_{code_from_text(line, 'detail')}"
        if code in seen:
            continue
        seen.add(code)
        findings.append(
            {
                "code": code,
                "severity": "blocker",
                "message": line,
                "evidence": {
                    "source": row.get("source"),
                    "returncode": row.get("returncode"),
                },
                "next_step": (
                    "Repair or archive the exact release evidence named by this "
                    "detail check and rerun product-release-check."
                ),
            }
        )
    return findings


required = [
    "package/e1-demo-pinout.yaml",
    "docs/package/e1-demo-package.md",
    "docs/package/e1-demo-pad-ring.md",
    "package/wifi-external-interface.yaml",
    "docs/pd/padframe/e1_demo_padframe.md",
    "pd/padframe/e1_demo_padframe.yaml",
    "pd/pin_order.cfg",
    "pd/signoff/manifest.yaml",
    "package/artifact-manifest.yaml",
    "docs/board/README.md",
    "docs/board/fpga/README.md",
    "board/fpga/artifact-manifest.yaml",
    "board/fpga/e1_demo_fpga.yaml",
    "board/fpga/constraints/e1_demo_ulx3s.lpf",
    "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-phone/artifact-manifest.yaml",
    "board/kicad/e1-phone/routed-release-plan.yaml",
    "docs/board/kicad/e1-demo/fab-notes.md",
    "docs/fw/board-smoke/tests/smoke_plan.md",
    "docs/manufacturing/e1-demo-checklist.md",
    "docs/manufacturing/artifact-manifest.yaml",
    "docs/manufacturing/release-manifest.yaml",
    "docs/manufacturing/real-world-verification-gaps.yaml",
    "docs/manufacturing/physical-closure-work-order.yaml",
    "docs/manufacturing/product-feature-evidence-manifest.yaml",
    "docs/project/product-architecture-security-radio-sensors-optimization-2026-05-17.yaml",
    "docs/pd/e1_chip_top_antenna_metadata_2026-05-18.md",
    "scripts/run_product_evidence_command.py",
]

missing = [p for p in required if not Path(p).exists()]
if missing:
    raise SystemExit("missing product artifacts: " + ", ".join(missing))

release_blockers: list[str] = []
preflight_checks: list[dict] = []
for command in [
    [sys.executable, "package/scripts/validate_pinout_vs_rtl.py"],
    [sys.executable, "scripts/check_fpga_target.py"],
    [sys.executable, "scripts/check_wifi_interface.py"],
    [sys.executable, "scripts/check_padframe_contract.py"],
    [sys.executable, "scripts/check_physical_closure_work_order.py"],
    [sys.executable, "scripts/check_package_cross_probe.py"],
    [sys.executable, "scripts/check_kicad_artifacts.py"],
    [sys.executable, "scripts/check_fpga_release.py"],
    [sys.executable, "scripts/check_openlane_run_preflight.py"],
    [sys.executable, "scripts/check_antenna_metadata.py"],
    [sys.executable, "scripts/check_pd_signoff.py", "--manifest-only"],
    [sys.executable, "scripts/check_manufacturing_artifacts.py"],
    [sys.executable, "scripts/check_real_world_gates.py"],
    [sys.executable, "scripts/check_product_feature_gates.py"],
    [sys.executable, "scripts/check_product_architecture_optimization.py"],
    [sys.executable, "scripts/run_product_evidence_command.py", "--list"],
]:
    result = subprocess.run(command, check=False, text=True, capture_output=True)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    check_row = {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
    preflight_checks.append(check_row)
    if result.returncode != 0:
        release_blockers.append(f"product preflight check failed: {' '.join(command[1:])}")

pinout = yaml.safe_load(Path("package/e1-demo-pinout.yaml").read_text())
package_name = str(pinout.get("package", ""))
pinout_notes = "\n".join(str(note) for note in pinout.get("notes", []))
if "placeholder" in package_name.lower() or "placeholder" in pinout_notes.lower():
    release_blockers.append("package pinout still declares a placeholder package")

for path in [
    "docs/package/e1-demo-package.md",
    "docs/package/e1-demo-pad-ring.md",
    "docs/board/kicad/e1-demo/fab-notes.md",
]:
    text = Path(path).read_text().lower()
    if (
        "placeholder" in text
        or "not a foundry-approved" in text
        or "does not instantiate foundry pad cells" in text
    ):
        release_blockers.append(f"{path} is still a placeholder/draft artifact")

kicad_dir = Path("board/kicad/e1-demo")
kicad_required = {
    "project": list(kicad_dir.glob("*.kicad_pro")),
    "schematic": list(kicad_dir.glob("*.kicad_sch")),
    "pcb": list(kicad_dir.glob("*.kicad_pcb")),
}
for artifact, matches in kicad_required.items():
    if not matches:
        release_blockers.append(f"missing KiCad {artifact} artifact under {kicad_dir}")

fpga = yaml.safe_load(Path("board/fpga/e1_demo_fpga.yaml").read_text())
if fpga.get("status") != "release_ready":
    release_blockers.append(f"FPGA target status is {fpga.get('status')}, not release_ready")
if fpga.get("board", {}).get("exact_revision") in {None, "", "unassigned"}:
    release_blockers.append("FPGA board exact_revision is unassigned")
if fpga.get("constraints", {}).get("bitstream_release_blocked_until_pins_assigned") is True:
    release_blockers.append("FPGA bitstream release is explicitly blocked until pins are assigned")

constraint_path = Path(fpga["constraints"]["skeleton_lpf"])
assigned_locs = [
    line
    for line in constraint_path.read_text().splitlines()
    if line.strip().startswith("LOCATE COMP") and not line.lstrip().startswith("#")
]
if not assigned_locs:
    release_blockers.append(f"{constraint_path} has no concrete FPGA LOCATE COMP assignments")

pd_signoff = subprocess.run(
    [sys.executable, "scripts/check_pd_signoff.py"],
    check=False,
    text=True,
    capture_output=True,
)
if pd_signoff.returncode != 0:
    release_blockers.append(
        "PD signoff artifacts/gates are incomplete; run scripts/check_pd_signoff.py for details"
    )

manufacturing_release = subprocess.run(
    [sys.executable, "scripts/check_manufacturing_artifacts.py", "--release"],
    check=False,
    text=True,
    capture_output=True,
)
if manufacturing_release.returncode != 0:
    release_blockers.append(
        "Manufacturing package/board/SI/PI/current/thermal evidence is incomplete; "
        "run scripts/check_manufacturing_artifacts.py --release for details"
    )

release_check_outputs: list[tuple[str, int, str, str]] = []
for release_check in [
    "scripts/check_package_cross_probe.py",
    "scripts/check_kicad_artifacts.py",
    "scripts/check_fpga_release.py",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_antenna_metadata.py",
]:
    result = subprocess.run(
        [sys.executable, release_check, "--release"],
        check=False,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        release_blockers.append(f"{release_check} --release failed")
        release_check_outputs.append(
            (release_check, result.returncode, result.stdout, result.stderr)
        )

if release_blockers:
    detail_checks = {
        "pd_signoff": {
            "command": [sys.executable, "scripts/check_pd_signoff.py"],
            "returncode": pd_signoff.returncode,
            "stdout": pd_signoff.stdout,
            "stderr": pd_signoff.stderr,
        },
        "manufacturing_release": {
            "command": [
                sys.executable,
                "scripts/check_manufacturing_artifacts.py",
                "--release",
            ],
            "returncode": manufacturing_release.returncode,
            "stdout": manufacturing_release.stdout,
            "stderr": manufacturing_release.stderr,
        },
        "release_checks": [
            {
                "command": [sys.executable, release_check, "--release"],
                "returncode": returncode,
                "script": release_check,
                "stdout": stdout,
                "stderr": stderr,
            }
            for release_check, returncode, stdout, stderr in release_check_outputs
        ],
    }
    report = {
        "schema": "eliza.product_release_status.v1",
        "status": "blocked",
        "release_mode": args.release,
        "claim_boundary": "product/package/board/PD scaffold only; not fabrication, bitstream, tapeout, or manufacturing release evidence",
        "release_blockers": release_blockers,
        "detail_checks": detail_checks,
        "preflight_checks": preflight_checks,
        "findings": structured_findings(release_blockers, detail_checks),
        "next_step": "close package/FPGA/KiCad/PD/manufacturing release blockers or keep product claim below fabrication",
    }
    write_report(report)
    if not args.release:
        emit_json(report)
        if args.json:
            raise SystemExit(0)
        print("product scaffold check ok; release blockers remain documented")
        print("run `make product-release-check` for fail-closed fabrication/tapeout gating")
        raise SystemExit(0)

    emit_json(report)
    if args.json:
        raise SystemExit(1)
    print("product release check failed:")
    for blocker in release_blockers:
        print(f"  - {blocker}")
    if pd_signoff.stdout:
        print("\nPD signoff detail:")
        print(pd_signoff.stdout.rstrip())
    if pd_signoff.stderr:
        print(pd_signoff.stderr.rstrip(), file=sys.stderr)
    if manufacturing_release.stdout:
        print("\nManufacturing artifact detail:")
        print(manufacturing_release.stdout.rstrip())
    if manufacturing_release.stderr:
        print(manufacturing_release.stderr.rstrip(), file=sys.stderr)
    for release_check, _returncode, stdout, stderr in release_check_outputs:
        if stdout:
            print(f"\n{release_check} detail:")
            print(stdout.rstrip())
        if stderr:
            print(stderr.rstrip(), file=sys.stderr)
    raise SystemExit(1)

report = {
    "schema": "eliza.product_release_status.v1",
    "status": "pass",
    "release_mode": args.release,
    "claim_boundary": "all configured product/package/board/PD release checks passed",
    "release_blockers": [],
    "detail_checks": {},
    "next_step": "none",
}
write_report(report)
emit_json(report)
print("product release check ok")
