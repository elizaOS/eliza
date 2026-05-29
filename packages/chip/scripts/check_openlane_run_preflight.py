#!/usr/bin/env python3
import json
import re
import shutil
import subprocess
import sys
from argparse import ArgumentParser
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "pd/signoff/manifest.yaml"
DEFAULT_OPENLANE_IMAGE = "ghcr.io/efabless/openlane2:2.4.0.dev1"
DEFAULT_OPENLANE_DIGEST = "sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5"
LOCK_DIR = ROOT / ".openlane-run.lock"
REPORT = ROOT / "build/reports/openlane_run_preflight.json"
RELEASE_REPORT = ROOT / "build/reports/openlane_run_release_preflight.json"
REPORT_SCHEMA = "eliza.openlane_run_preflight.v1"
RELEASE_CONFIGS = (
    "pd/openlane/config.json",
    "pd/openlane/config.sky130.json",
    "pd/openlane/config.gf180.json",
)
EXPLORATORY_CONFIGS = (
    "pd/openlane/config.sky130.exploratory.json",
    "pd/openlane/config.gf180.exploratory.json",
)


def docker_image_id(image: str) -> str | None:
    if not shutil.which("docker"):
        return None
    result = subprocess.run(
        ["docker", "image", "inspect", image, "--format", "{{index .RepoDigests 0}}"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def docker_manifest_contains_digest(image: str, digest: str) -> bool | None:
    if not shutil.which("docker"):
        return None
    result = subprocess.run(
        ["docker", "manifest", "inspect", "--verbose", image],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return None
    return digest in result.stdout


def pid_is_running(pid_text: str) -> bool:
    try:
        int(pid_text.strip())
    except ValueError:
        return False
    return (
        subprocess.run(
            ["kill", "-0", pid_text.strip()],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0
    )


def active_labeled_openlane_containers() -> list[str]:
    if not shutil.which("docker"):
        return []
    result = subprocess.run(
        [
            "docker",
            "ps",
            "--filter",
            "label=eliza.openlane=1",
            "--filter",
            f"label=eliza.repo={ROOT}",
            "--format",
            "{{.ID}} {{.Status}} {{.Names}}",
        ],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def run_orchestration_blockers() -> list[str]:
    blockers: list[str] = []
    if LOCK_DIR.exists():
        pid_path = LOCK_DIR / "pid"
        if pid_path.is_file() and pid_is_running(pid_path.read_text()):
            blockers.append(
                f"OpenLane launcher lock is active under pid {pid_path.read_text().strip()}"
            )
        else:
            blockers.append(f"stale OpenLane launcher lock exists: {LOCK_DIR.relative_to(ROOT)}")
    active_containers = active_labeled_openlane_containers()
    if active_containers:
        blockers.append(
            "active labeled OpenLane Docker containers exist for this repo: "
            + "; ".join(active_containers)
        )
    return blockers


def numbered_step_dirs(run_dir: Path) -> list[Path]:
    return sorted(
        path for path in run_dir.iterdir() if path.is_dir() and re.match(r"^[0-9]+-", path.name)
    )


def latest_run_blockers(run_dirs: list[Path]) -> list[str]:
    if not run_dirs:
        return []
    latest = max(run_dirs, key=lambda path: path.stat().st_mtime)
    rel_latest = latest.relative_to(ROOT)
    if (latest / "final").is_dir():
        return []
    steps = numbered_step_dirs(latest)
    if not steps:
        return [f"latest OpenLane run has no numbered steps and no final outputs: {rel_latest}"]
    incomplete = [step for step in steps if not (step / "state_out.json").is_file()]
    if incomplete:
        last_complete = next(
            (step for step in reversed(steps) if (step / "state_out.json").is_file()), None
        )
        detail = f"; last completed step: {last_complete.name}" if last_complete else ""
        return [f"latest OpenLane run is incomplete at {rel_latest}/{incomplete[0].name}{detail}"]
    return [f"latest OpenLane run has completed steps but no final outputs: {rel_latest}"]


def validate_openlane_config(config_path: Path, failures: list[str]) -> dict:
    if not config_path.is_file():
        failures.append(f"missing OpenLane config: {config_path.relative_to(ROOT)}")
        return {}
    try:
        config = json.loads(config_path.read_text())
    except json.JSONDecodeError as exc:
        failures.append(f"{config_path.relative_to(ROOT)}: invalid JSON: {exc}")
        return {}
    for key in ("DESIGN_NAME", "VERILOG_FILES", "CLOCK_PORT", "CLOCK_PERIOD"):
        if key not in config:
            failures.append(f"{config_path.relative_to(ROOT)}: missing {key}")
    if config.get("DESIGN_NAME") != "e1_chip_top":
        failures.append(f"{config_path.relative_to(ROOT)}: DESIGN_NAME must be e1_chip_top")
    if not isinstance(config.get("VERILOG_FILES"), list) or not config["VERILOG_FILES"]:
        failures.append(f"{config_path.relative_to(ROOT)}: VERILOG_FILES must be a non-empty list")
    return config


def release_config_blockers(configs: dict[str, dict]) -> list[str]:
    required_true = (
        "QUIT_ON_TIMING_VIOLATIONS",
        "QUIT_ON_MAGIC_DRC",
        "QUIT_ON_LVS_ERROR",
        "QUIT_ON_SLEW_VIOLATIONS",
    )
    blockers: list[str] = []
    for config_name, config in configs.items():
        if config_name not in RELEASE_CONFIGS:
            continue
        if not isinstance(config, dict) or not config:
            continue
        fail_open = [key for key in required_true if config.get(key) is not True]
        if fail_open:
            blockers.append(
                f"{config_name} is exploratory for release; require true " + ", ".join(fail_open)
            )
    return blockers


def release_artifact_blockers(manifest: dict) -> list[str]:
    blocked_gates = manifest.get("blocked_gates", {})
    gate_blockers = []
    if isinstance(blocked_gates, dict):
        for gate_name, gate in blocked_gates.items():
            if isinstance(gate, dict) and gate.get("blocked") is True:
                reason = gate.get("reason")
                detail = f": {reason}" if isinstance(reason, str) and reason else ""
                gate_blockers.append(f"release gate remains blocked: {gate_name}{detail}")

    required = manifest.get("required_artifacts", {})
    if not isinstance(required, dict):
        return gate_blockers + ["pd/signoff/manifest.yaml must list required_artifacts for release"]

    missing: list[str] = []
    dirty: list[str] = []
    unproven_clean: list[str] = []
    for name, spec in required.items():
        if not isinstance(spec, dict):
            missing.append(str(name))
            continue
        min_bytes = int(spec.get("min_bytes", 1))
        globs = spec.get("globs", [])
        files = (
            [
                path
                for pattern in globs
                for path in ROOT.glob(str(pattern))
                if path.is_file() and path.stat().st_size >= min_bytes
            ]
            if isinstance(globs, list)
            else []
        )
        if not files:
            missing.append(str(name))
            continue

        fail_regex = spec.get("fail_regex")
        pass_regex = spec.get("pass_regex")
        fail_pattern = (
            re.compile(fail_regex) if isinstance(fail_regex, str) and fail_regex else None
        )
        pass_pattern = (
            re.compile(pass_regex) if isinstance(pass_regex, str) and pass_regex else None
        )
        matched_pass = False
        for path in files:
            text = path.read_text(errors="ignore")
            if fail_pattern and fail_pattern.search(text):
                dirty.append(f"{name}: {path.relative_to(ROOT)}")
            if pass_pattern and pass_pattern.search(text):
                matched_pass = True
        if pass_pattern and not matched_pass:
            unproven_clean.append(str(name))
    if missing:
        gate_blockers.append("release requires OpenLane signoff artifacts: " + ", ".join(missing))
    if dirty:
        gate_blockers.append(
            "release requires clean OpenLane reports; dirty reports: " + ", ".join(dirty)
        )
    if unproven_clean:
        gate_blockers.append(
            "release requires explicit clean markers in OpenLane reports: "
            + ", ".join(unproven_clean)
        )
    return gate_blockers


def blocker_category(blocker: str) -> str:
    lowered = blocker.lower()
    if "release gate remains blocked:" in lowered:
        if "pd_release" in lowered:
            return "pd_release_gate_blocked"
        if "tapeout_release" in lowered:
            return "tapeout_release_gate_blocked"
        if "board_fabrication_release" in lowered:
            return "board_fabrication_release_gate_blocked"
        return "release_gate_blocked"
    if "openlane command missing" in lowered or "docker image" in lowered:
        return "runner_unavailable"
    if "latest openlane run" in lowered:
        return "run_incomplete_or_missing_final"
    if "release requires openlane signoff artifacts" in lowered:
        return "release_artifacts_missing"
    if "release requires clean openlane reports" in lowered:
        return "dirty_signoff_reports"
    if "explicit clean markers" in lowered:
        return "clean_markers_missing"
    if "stale openlane launcher lock" in lowered or "launcher lock is active" in lowered:
        return "orchestration_lock"
    if "active labeled openlane docker containers" in lowered:
        return "orchestration_container_active"
    if "exploratory for release" in lowered:
        return "release_config_not_fail_closed"
    return "openlane_release_blocker"


def release_gate_records(manifest: dict) -> list[dict]:
    blocked_gates = manifest.get("blocked_gates", {})
    if not isinstance(blocked_gates, dict):
        return []
    records = []
    for gate_name, gate in sorted(blocked_gates.items()):
        if not isinstance(gate, dict) or gate.get("blocked") is not True:
            continue
        records.append(
            {
                "gate": gate_name,
                "blocked": True,
                "reason": gate.get("reason"),
                "evidence_manifest": gate.get("evidence_manifest"),
                "unblock_requires": gate.get("unblock_requires", []),
                "release_credit": False,
            }
        )
    return records


def blocker_category_counts(blockers: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for blocker in blockers:
        category = blocker_category(blocker)
        counts[category] = counts.get(category, 0) + 1
    return counts


def write_report(
    report_path: Path,
    status: str,
    failures: list[str],
    blockers: list[str],
    *,
    release: bool,
    image: str,
    digest_pin: str,
    manifest: dict | None = None,
) -> None:
    findings = []
    for failure in failures:
        findings.append(
            {
                "code": "openlane_preflight_failure",
                "message": failure,
                "next_step": "fix OpenLane manifest/config structure",
                "severity": "error",
            }
        )
    for blocker in blockers:
        findings.append(
            {
                "code": "openlane_release_blocked",
                "message": blocker,
                "next_step": "run a complete pinned OpenLane flow and archive release-clean signoff artifacts",
                "severity": "blocker",
            }
        )
    report = {
        "schema": REPORT_SCHEMA,
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "summary": {
            "release_mode": release,
            "failure_count": len(failures),
            "blocker_count": len(blockers),
            "blocker_category_counts": blocker_category_counts(blockers),
            "blocked_release_gate_count": len(release_gate_records(manifest or {})),
            "release_ready": status == "pass",
            "openlane_image": image,
            "openlane_image_digest": digest_pin,
        },
        "findings": findings,
        "diagnostics": {
            "blocked_release_gates": release_gate_records(manifest or {}),
            "blocker_categories": [
                {
                    "category": category,
                    "count": count,
                    "release_credit": False,
                }
                for category, count in sorted(blocker_category_counts(blockers).items())
            ],
        },
        "claim_boundary": "openlane_preflight_report_only_not_pd_release_evidence",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = ArgumentParser(description="Check OpenLane/OpenROAD image and run-root readiness.")
    parser.add_argument(
        "--release",
        action="store_true",
        help="require installed pinned image and at least one run directory",
    )
    parser.add_argument(
        "--report",
        help="write JSON report to this path (default: normal or release mode report path)",
    )
    args = parser.parse_args()
    report_path = Path(args.report) if args.report else (RELEASE_REPORT if args.release else REPORT)

    manifest = yaml.safe_load(MANIFEST.read_text())
    runner = manifest.get("runner", {}) if isinstance(manifest, dict) else {}
    image = runner.get("openlane_image", DEFAULT_OPENLANE_IMAGE)
    digest_pin = runner.get("openlane_image_digest", DEFAULT_OPENLANE_DIGEST)
    failures: list[str] = []
    blockers: list[str] = []
    if not isinstance(image, str) or not image:
        failures.append("pd/signoff/manifest.yaml runner.openlane_image must be a non-empty string")
        image = DEFAULT_OPENLANE_IMAGE
    if not isinstance(digest_pin, str) or not digest_pin.startswith("sha256:"):
        failures.append(
            "pd/signoff/manifest.yaml runner.openlane_image_digest must be a sha256 digest"
        )
        digest_pin = DEFAULT_OPENLANE_DIGEST

    configs: dict[str, dict] = {}
    for config_name in RELEASE_CONFIGS + EXPLORATORY_CONFIGS:
        configs[config_name] = validate_openlane_config(ROOT / config_name, failures)

    run_roots = manifest.get("run_roots", [])
    if not isinstance(run_roots, list) or not run_roots:
        failures.append("pd/signoff/manifest.yaml must list run_roots")
    else:
        run_dirs = [
            path for run_root in run_roots for path in (ROOT / run_root).glob("*") if path.is_dir()
        ]
        if not run_dirs:
            blockers.append("no OpenLane/OpenROAD run directories exist under configured run_roots")
        else:
            blockers.extend(latest_run_blockers(run_dirs))

    if args.release:
        blockers.extend(release_config_blockers(configs))
        blockers.extend(release_artifact_blockers(manifest if isinstance(manifest, dict) else {}))

    blockers.extend(run_orchestration_blockers())

    if shutil.which("openlane") or shutil.which("flow.tcl"):
        pass
    else:
        manifest_match = docker_manifest_contains_digest(image, digest_pin)
        digest = docker_image_id(image)
        if digest is None:
            blockers.append(f"OpenLane command missing and Docker image is not installed: {image}")
        elif digest_pin not in digest and manifest_match is not True:
            blockers.append(f"OpenLane Docker image digest is not pinned to {digest_pin}: {digest}")
        if manifest_match is False:
            blockers.append(
                f"OpenLane remote manifest does not contain pinned digest {digest_pin}: {image}"
            )

    if failures:
        write_report(
            report_path,
            "fail",
            failures,
            blockers,
            release=args.release,
            image=image,
            digest_pin=digest_pin,
            manifest=manifest if isinstance(manifest, dict) else {},
        )
        print("OpenLane run preflight failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        write_report(
            report_path,
            "blocked",
            failures,
            blockers,
            release=args.release,
            image=image,
            digest_pin=digest_pin,
            manifest=manifest if isinstance(manifest, dict) else {},
        )
        print("STATUS: BLOCKED openlane_run_preflight")
        print("OpenLane run preflight blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        if args.release:
            return 2
        print("OpenLane configs are present; run/image evidence is still blocked.")
        return 0

    write_report(
        report_path,
        "pass",
        failures,
        blockers,
        release=args.release,
        image=image,
        digest_pin=digest_pin,
        manifest=manifest if isinstance(manifest, dict) else {},
    )
    print("STATUS: PASS openlane_run_preflight")
    print("OpenLane run preflight passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
