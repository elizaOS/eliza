#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIGS = [
    ROOT / "pd/openlane/config.json",
    ROOT / "pd/openlane/config.sky130.json",
    ROOT / "pd/openlane/config.sky130.exploratory.json",
    ROOT / "pd/openlane/config.gf180.json",
    ROOT / "pd/openlane/config.gf180.exploratory.json",
    ROOT / "pd/openlane/config.pd-smoke.sky130.json",
]
OPENLANE_IMAGE = "ghcr.io/efabless/openlane2:2.4.0.dev1"
OPENLANE_IMAGE_DIGEST = "sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5"
OPENLANE2_BIN = ROOT / "external/openlane2/.venv/bin/openlane"
REQUIRED_KEYS = {
    "DESIGN_NAME",
    "VERILOG_FILES",
    "CLOCK_PORT",
    "CLOCK_PERIOD",
}
OPENROAD_TCL = ROOT / "pd/openroad/e1_soc.tcl"
PD_INPUTS = [
    OPENROAD_TCL,
    ROOT / "pd/constraints/e1_soc.sdc",
    ROOT / "pd/constraints/e1_soc_gf180.sdc",
    ROOT / "pd/constraints/e1_pd_smoke.sdc",
    ROOT / "pd/pin_order.cfg",
    ROOT / "pd/pin_order_smoke.cfg",
]
CONFIG_BY_PDK = {
    "sky130A": ROOT / "pd/openlane/config.sky130.json",
    "gf180mcuC": ROOT / "pd/openlane/config.gf180.json",
}


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def resolve_dir_path(config_path: Path, value: str) -> Path:
    if value.startswith("dir::"):
        return (config_path.parent / value.removeprefix("dir::")).resolve()
    return (ROOT / value).resolve()


def resolve_pdk_dir(pdk_root: Path, pdk: str) -> Path | None:
    flat_pdk = pdk_root / pdk
    if flat_pdk.is_dir():
        return flat_pdk
    volare_families = [pdk]
    if pdk == "sky130A":
        volare_families.insert(0, "sky130")
    elif pdk.startswith("gf180mcu"):
        volare_families.insert(0, "gf180mcu")
    for family in volare_families:
        volare_versions = pdk_root / "volare" / family / "versions"
        if volare_versions.is_dir():
            for candidate in sorted(volare_versions.glob(f"*/{pdk}"), reverse=True):
                if candidate.is_dir():
                    return candidate
    return None


def load_config(config_path: Path, failures: list[str]) -> dict | None:
    try:
        return json.loads(config_path.read_text())
    except json.JSONDecodeError as exc:
        failures.append(f"{display_path(config_path)}: invalid JSON: {exc}")
        return None


def check_config(config_path: Path, failures: list[str]) -> dict | None:
    config = load_config(config_path, failures)
    if config is None:
        return None
    missing_keys = sorted(REQUIRED_KEYS - set(config))
    if missing_keys:
        failures.append(f"{display_path(config_path)}: missing keys: {', '.join(missing_keys)}")

    valid_design_names = {"e1_chip_top", "e1_pd_smoke_top"}
    if config.get("DESIGN_NAME") not in valid_design_names:
        failures.append(
            f"{display_path(config_path)}: DESIGN_NAME must be one of "
            f"{', '.join(sorted(valid_design_names))}"
        )
    if config.get("CLOCK_PORT") != "CLK_IN":
        failures.append(f"{display_path(config_path)}: CLOCK_PORT must be CLK_IN")
    if not isinstance(config.get("CLOCK_PERIOD"), (int, float)) or config["CLOCK_PERIOD"] <= 0:
        failures.append(f"{display_path(config_path)}: CLOCK_PERIOD must be positive")

    verilog_files = config.get("VERILOG_FILES")
    if not isinstance(verilog_files, list) or not verilog_files:
        failures.append(f"{display_path(config_path)}: VERILOG_FILES must be a non-empty list")
        return config
    for entry in verilog_files:
        if not isinstance(entry, str):
            failures.append(f"{display_path(config_path)}: VERILOG_FILES entries must be strings")
            continue
        path = resolve_dir_path(config_path, entry)
        if not path.is_file():
            failures.append(f"{display_path(config_path)}: missing RTL source {entry}")

    for key in ("SIGNOFF_SDC_FILE", "FP_PIN_ORDER_CFG"):
        if key in config:
            value = config[key]
            if not isinstance(value, str):
                failures.append(f"{display_path(config_path)}: {key} must be a string")
                continue
            path = resolve_dir_path(config_path, value)
            if not path.is_file():
                failures.append(f"{display_path(config_path)}: missing {key} file {value}")
    return config


def check_pdk_environment(
    config_path: Path, config: dict, failures: list[str], blockers: list[str]
) -> None:
    pdk = config.get("PDK")
    library = config.get("STD_CELL_LIBRARY")
    if config_path.name != "config.json":
        if not isinstance(pdk, str) or not pdk:
            failures.append(f"{display_path(config_path)}: PDK must be a non-empty string")
        if not isinstance(library, str) or not library:
            failures.append(
                f"{display_path(config_path)}: STD_CELL_LIBRARY must be a non-empty string"
            )

    pdk_root = os.environ.get("PDK_ROOT")
    if not pdk_root:
        if pdk:
            blockers.append(
                f"{display_path(config_path)}: PDK_ROOT is not set; cannot verify installed PDK {pdk}"
            )
        return
    root_path = Path(pdk_root).expanduser()
    if not root_path.is_dir():
        blockers.append(f"PDK_ROOT does not exist or is not a directory: {pdk_root}")
        return
    if pdk and resolve_pdk_dir(root_path, pdk) is None:
        blockers.append(
            f"{display_path(config_path)}: PDK_ROOT is set but missing PDK directory {root_path / pdk}"
        )


def shell_join(args: list[str]) -> str:
    return " ".join(
        "'" + arg.replace("'", "'\"'\"'") + "'" if any(ch.isspace() for ch in arg) else arg
        for arg in args
    )


def openlane_command(config_path: Path) -> tuple[str, list[str]]:
    rel_config = str(config_path.relative_to(ROOT))
    if OPENLANE2_BIN.is_file():
        return "openlane2", [str(OPENLANE2_BIN), rel_config]
    if shutil.which("openlane"):
        return "openlane", ["openlane", rel_config]
    if shutil.which("flow.tcl") and config_path.name == "config.json":
        return "flow.tcl", ["flow.tcl", "-design", "pd/openlane"]
    return "docker", [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{ROOT}:/work",
        "-w",
        "/work",
        "--label",
        "eliza.openlane=1",
        "--label",
        f"eliza.repo={ROOT}",
        OPENLANE_IMAGE,
        "openlane",
        rel_config,
    ]


def openroad_command() -> list[str]:
    return ["openroad", str(OPENROAD_TCL.relative_to(ROOT))]


def print_dry_run(config_path: Path) -> None:
    runner, command = openlane_command(config_path)
    print(f"PD dry-run OpenLane runner: {runner}")
    print("PD dry-run OpenLane command: " + shell_join(command))
    print("PD dry-run OpenROAD command: " + shell_join(openroad_command()))


def main() -> int:
    parser = ArgumentParser(
        description="Validate local PD OpenLane/OpenROAD inputs and command construction."
    )
    parser.add_argument(
        "--dry-run-commands",
        action="store_true",
        help="print command lines that would be used without running OpenLane/OpenROAD",
    )
    parser.add_argument(
        "--config",
        default="pd/openlane/config.sky130.json",
        help="OpenLane config used for dry-run command construction",
    )
    args = parser.parse_args()

    failures: list[str] = []
    blockers: list[str] = []
    loaded_configs: dict[Path, dict] = {}
    for config_path in CONFIGS:
        if not config_path.is_file():
            failures.append(f"missing OpenLane config: {config_path.relative_to(ROOT)}")
            continue
        config = check_config(config_path, failures)
        if config is not None:
            loaded_configs[config_path] = config
            check_pdk_environment(config_path, config, failures, blockers)

    seen_pdks: dict[str, set[Path]] = {}
    for config_path, config in loaded_configs.items():
        pdk = config.get("PDK")
        if isinstance(pdk, str):
            seen_pdks.setdefault(pdk, set()).add(config_path)
    for pdk, expected_config in CONFIG_BY_PDK.items():
        if expected_config not in seen_pdks.get(pdk, set()):
            failures.append(f"PDK {pdk} must be covered by {expected_config.relative_to(ROOT)}")

    dry_run_config = (ROOT / args.config).resolve()
    try:
        dry_run_config.relative_to(ROOT)
    except ValueError:
        failures.append(f"--config must point inside this repository: {args.config}")
    if not dry_run_config.is_file():
        failures.append(f"dry-run config missing: {args.config}")
    elif dry_run_config not in loaded_configs:
        config = check_config(dry_run_config, failures)
        if config is not None:
            loaded_configs[dry_run_config] = config

    for path in PD_INPUTS:
        if not path.is_file():
            failures.append(f"missing PD input: {path.relative_to(ROOT)}")

    if failures:
        print("PD preflight check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PD preflight check passed.")
    if args.dry_run_commands:
        print_dry_run(dry_run_config)
    if blockers:
        print("PD preflight blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
    if shutil.which("openlane") or shutil.which("flow.tcl"):
        print("PD tool status: OpenLane command found on PATH.")
    elif shutil.which("docker"):
        result = subprocess.run(
            ["docker", "image", "inspect", OPENLANE_IMAGE],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode == 0:
            print(f"PD tool status: Docker image installed: {OPENLANE_IMAGE}")
            print(f"PD image digest pin: {OPENLANE_IMAGE_DIGEST}")
        else:
            print(
                f"PD tool status: Docker is available, but OpenLane image is missing: {OPENLANE_IMAGE}"
            )
            print(
                "PD next command: "
                f"OPENLANE_IMAGE={OPENLANE_IMAGE} "
                f"OPENLANE_IMAGE_DIGEST={OPENLANE_IMAGE_DIGEST} "
                "scripts/install_openlane_image.sh"
            )
    else:
        print("PD tool status: OpenLane command and docker are missing.")
        print(
            "PD next command: install OpenLane 2, or install Docker and rerun pd-preflight-check."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
