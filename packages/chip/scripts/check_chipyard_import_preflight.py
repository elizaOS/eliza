#!/usr/bin/env python3
"""Validate the pinned Chipyard checkout before any Rocket import/generation claim."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/generators/chipyard/eliza-rocket-manifest.json"
DEFAULT_CHECKOUT = ROOT / "external/chipyard"
DEFAULT_REPORT = ROOT / "build/chipyard/eliza_rocket/bootstrap-preflight.json"
FALLBACK_REPORT = ROOT / "benchmarks/results/chipyard/bootstrap-preflight.json"


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd or ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def write_report(path: Path, evidence: dict) -> Path:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path
    except PermissionError:
        fallback = FALLBACK_REPORT
        evidence["report_write_fallback"] = {
            "requested": rel(path),
            "actual": rel(fallback),
            "reason": "requested_report_path_not_writable",
        }
        fallback.parent.mkdir(parents=True, exist_ok=True)
        fallback.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return fallback


def submodule_problem_details(lines: list[str]) -> dict[str, list[str]]:
    missing: list[str] = []
    drifted: list[str] = []
    conflicts: list[str] = []
    for line in lines:
        if not line:
            continue
        state = line[0]
        path = line[1:].strip().split()[1] if len(line[1:].strip().split()) >= 2 else line
        if state == "-":
            missing.append(path)
        elif state == "+":
            drifted.append(path)
        elif state == "U":
            conflicts.append(path)
    return {"missing": missing, "drifted": drifted, "conflicts": conflicts}


def validate_config_sources(
    selected: dict,
    checkout: Path,
    checks: dict[str, object],
    errors: list[str],
    blockers: list[str],
) -> None:
    sources = selected.get("config_sources", [])
    if not isinstance(sources, list) or not sources:
        errors.append("selected_path.config_sources must list the ElizaRocketConfig overlay")
        return

    source_checks: list[dict[str, object]] = []
    for entry in sources:
        if not isinstance(entry, dict):
            errors.append("selected_path.config_sources entries must be objects")
            continue
        source = entry.get("source")
        destination = entry.get("checkout_destination")
        if not isinstance(source, str) or not isinstance(destination, str):
            errors.append("config source entries must include source and checkout_destination")
            continue
        source_path = ROOT / source
        destination_path = checkout / destination
        record = {
            "source": source,
            "checkout_destination": destination,
            "source_exists": source_path.is_file(),
            "installed_in_checkout": destination_path.is_file(),
        }
        source_checks.append(record)
        if not source_path.is_file():
            errors.append(f"missing ElizaRocketConfig source overlay: {source}")
            continue
        text = source_path.read_text(encoding="utf-8", errors="ignore")
        if "package eliza" not in text:
            errors.append(f"{source} must declare package eliza")
        if "class ElizaRocketConfig" not in text:
            errors.append(f"{source} must define class ElizaRocketConfig")
        if "WithNHugeCores(1)" not in text:
            errors.append(f"{source} must select one Rocket hart for initial Linux bring-up")
        if checkout.is_dir() and not destination_path.is_file():
            blockers.append(
                "ElizaRocketConfig overlay is not installed in checkout; run "
                "scripts/bootstrap_chipyard.sh to copy "
                f"{source} to external/chipyard/{destination}"
            )
        elif destination_path.is_file():
            installed = destination_path.read_text(encoding="utf-8", errors="ignore")
            if installed != text:
                errors.append(
                    "installed ElizaRocketConfig overlay differs from repo source: "
                    f"external/chipyard/{destination}"
                )
    checks["config_sources"] = source_checks


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--checkout", default=str(DEFAULT_CHECKOUT), help="Path to a Chipyard checkout"
    )
    parser.add_argument(
        "--write-report",
        default=os.environ.get("CHIPYARD_PREFLIGHT_REPORT", str(DEFAULT_REPORT)),
        help="Write JSON preflight report",
    )
    parser.add_argument(
        "--require-checkout", action="store_true", help="Return non-zero if checkout is absent"
    )
    parser.add_argument(
        "--skip-remote", action="store_true", help="Skip git ls-remote tag validation"
    )
    args = parser.parse_args()

    manifest = load_manifest()
    chipyard = manifest["chipyard"]
    selected = manifest["selected_path"]
    checkout = Path(args.checkout)
    report_path = Path(args.write_report)
    if not report_path.is_absolute():
        report_path = ROOT / report_path

    errors: list[str] = []
    blockers: list[str] = []
    checks: dict[str, object] = {}
    evidence: dict[str, object] = {
        "schema": "eliza.cpu_ap_bootstrap_preflight.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "manifest": str(MANIFEST.relative_to(ROOT)),
        "checkout": str(checkout),
        "chipyard": {
            "repo": chipyard.get("repo"),
            "tag": chipyard.get("tag"),
            "commit": chipyard.get("commit"),
        },
        "selected_path": {
            "config_name": selected.get("config_name"),
            "package_name": selected.get("package_name"),
            "core": selected.get("core"),
            "isa": selected.get("isa"),
            "harts": selected.get("harts"),
        },
        "checks": checks,
    }

    if shutil.which("git") is None:
        errors.append("git is not available")
    else:
        checks["git_available"] = True

    validate_config_sources(selected, checkout, checks, errors, blockers)

    if not args.skip_remote and not errors:
        remote = run(
            ["git", "ls-remote", "--tags", chipyard["repo"], f"refs/tags/{chipyard['tag']}"]
        )
        checks["remote_tag_output"] = remote.stdout.strip()
        if remote.returncode != 0:
            errors.append("could not query pinned Chipyard tag from remote")
        else:
            resolved = remote.stdout.split()[0] if remote.stdout.split() else ""
            if resolved != chipyard["commit"]:
                errors.append(
                    f"remote tag {chipyard['tag']} resolves to {resolved}, expected {chipyard['commit']}"
                )

    if not checkout.is_dir():
        blockers.append(f"missing Chipyard checkout: {checkout}")
    elif not (checkout / ".git").exists():
        errors.append(f"checkout is not a git repository: {checkout}")
    elif not errors:
        head = run(["git", "rev-parse", "HEAD"], cwd=checkout)
        checks["checkout_head"] = head.stdout.strip()
        if head.returncode != 0:
            errors.append("could not read Chipyard checkout HEAD")
        elif head.stdout.strip() != chipyard["commit"]:
            errors.append(f"checkout HEAD is {head.stdout.strip()}, expected {chipyard['commit']}")

        required_submodules = (
            "generators/rocket-chip",
            "tools/cde",
            "tools/firrtl2",
            "tools/install-circt",
            "tools/rocket-dsp-utils",
            "generators/bar-fetchers",
            "generators/rocc-acc-utils",
            "sims/verilator",
            "software/firemarshal",
        )
        submodules = run(["git", "submodule", "status", *required_submodules], cwd=checkout)
        submodule_lines = [line for line in submodules.stdout.splitlines() if line.strip()]
        checks["required_submodules"] = list(required_submodules)
        checks["required_submodule_count"] = len(submodule_lines)
        checks["required_submodule_problems"] = submodule_problem_details(submodule_lines)
        if submodules.returncode != 0:
            errors.append("could not read required Chipyard recursive submodule status")
        elif not submodule_lines:
            errors.append("Chipyard checkout has no required recursive submodule status output")
        elif any(line.startswith("-") or line.startswith("+") for line in submodule_lines):
            details = submodule_problem_details(submodule_lines)
            for path in details["missing"]:
                errors.append(f"required Chipyard submodule is not initialized: {path}")
            for path in details["drifted"]:
                errors.append(f"required Chipyard submodule is not at recorded SHA: {path}")
            for path in details["conflicts"]:
                errors.append(f"required Chipyard submodule has merge conflict: {path}")

        for relative in ("generators/rocket-chip", "sims/verilator", "software/firemarshal"):
            checkout_path = checkout / relative
            checks[f"exists:{relative}"] = checkout_path.exists()
            if not checkout_path.exists():
                errors.append(f"Chipyard checkout lacks expected path: {relative}")

    evidence["status"] = "fail" if errors else "blocked" if blockers else "pass"
    evidence["errors"] = errors
    evidence["blockers"] = blockers
    report_path = write_report(report_path, evidence)

    if errors:
        print("STATUS: FAIL chipyard.import_preflight - pinned checkout validation failed")
        for error in errors:
            print(f"  - {error}")
        if blockers:
            print("BLOCKERS:")
            for blocker in blockers:
                print(f"  - {blocker}")
        print(f"REPORT: {report_path.relative_to(ROOT)}")
        return 1

    if blockers:
        print(
            "STATUS: BLOCKED chipyard.import_preflight - external Chipyard checkout is not available"
        )
        for blocker in blockers:
            print(f"  - {blocker}")
        print(f"REPORT: {report_path.relative_to(ROOT)}")
        return 1 if args.require_checkout else 0

    print(
        "STATUS: PASS chipyard.import_preflight - pinned Chipyard checkout is ready for Rocket import"
    )
    print(f"REPORT: {report_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
