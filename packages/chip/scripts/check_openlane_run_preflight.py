#!/usr/bin/env python3
import json
import re
import shutil
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "pd/signoff/manifest.yaml"
DEFAULT_OPENLANE_IMAGE = "ghcr.io/efabless/openlane2:2.4.0.dev1"
DEFAULT_OPENLANE_DIGEST = "sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5"
LOCK_DIR = ROOT / ".openlane-run.lock"
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


def main() -> int:
    parser = ArgumentParser(description="Check OpenLane/OpenROAD image and run-root readiness.")
    parser.add_argument(
        "--release",
        action="store_true",
        help="require installed pinned image and at least one run directory",
    )
    args = parser.parse_args()

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
        print("OpenLane run preflight failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        print("OpenLane run preflight blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        if args.release:
            return 1
        print("OpenLane configs are present; run/image evidence is still blocked.")
        return 0

    print("OpenLane run preflight passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
