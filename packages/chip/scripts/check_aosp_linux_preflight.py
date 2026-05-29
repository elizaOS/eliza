#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from provenance_sanitize import sanitize_host_local_paths

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(
    os.environ.get("AOSP_LINUX_PREFLIGHT_REPORT", ROOT / "build/reports/aosp_linux_preflight.json")
)
CLAIM_BOUNDARY = "host_preflight_only_not_aosp_build_boot_cuttlefish_or_e1_chip_hardware_evidence"
DEFAULT_AOSP_DIRS = (Path("/home/shaw/aosp"),)
TOOL_DEFAULT_PATHS = {
    "renode": (ROOT / "tools/bin/renode", ROOT / "external/renode_1.16.1-dotnet_portable/renode"),
}
SMOKE_COMMAND_DEFAULTS = {
    "AOSP_QEMU_SMOKE_COMMAND": ROOT / "scripts/aosp_qemu_smoke_command.sh",
    "AOSP_RENODE_SMOKE_COMMAND": ROOT / "scripts/aosp_renode_smoke_command.sh",
}

LINUX_REQUIREMENTS = [
    "Linux host with hardware virtualization enabled",
    "AOSP_DIR set to an AOSP checkout containing build/envsetup.sh and device/",
    "/dev/kvm present and readable/writable by the running user",
    "repo available on PATH for checkout sync/bootstrap; adb available on PATH for boot smoke",
    "launch_cvd or cvd available on PATH or under AOSP_DIR/out/host/linux-x86/bin",
    "user in kvm/cvdnetwork/render groups, or equivalent host permissions",
]

EXECUTION_TRACKS = {
    "import": [
        "AOSP checkout shape is valid",
        "repo-local sw/aosp-device inputs are present",
        "device/eliza/eliza_ai_soc can be copied into the external tree",
    ],
    "build": [
        "lunch eliza_ai_soc-trunk_staging-userdebug",
        "m vendorimage",
        "checkvintf against out/target/product/eliza_ai_soc/vendor",
        "m vendor_sepolicy.cil selinux_policy",
        "m sepolicy_neverallows",
    ],
    "cuttlefish": [
        "launch_cvd or cvd from PATH or AOSP_DIR/out/host/linux-x86/bin",
        "adb smoke checks",
        "ro.product.cpu.abi=riscv64",
        "sys.boot_completed=1",
    ],
    "compatibility_intake": [
        "CTS/VTS tools build or are available",
        "bounded smoke plan transcript is captured",
        "no full Android compatibility or certification claim is made",
    ],
    "qemu": [
        "qemu-system-riscv64 is installed",
        "AOSP_QEMU_SMOKE_COMMAND is set to the checkout-specific smoke command",
    ],
    "renode": [
        "renode is installed",
        "AOSP_RENODE_SMOKE_COMMAND is set to the checkout-specific smoke command",
    ],
}

HANDOFF_COMMANDS = [
    "python3 scripts/check_aosp_linux_preflight.py --write-report",
    "AOSP_DIR=$AOSP_DIR scripts/run_aosp_linux_handoff.sh --build-only",
    'sw/aosp-device/import-aosp-device.sh --check "$AOSP_DIR"',
    "make aosp-bsp-check",
    "AOSP_DIR=$AOSP_DIR scripts/boot_android_simulator.sh --run-cuttlefish --run-cts --run-vts --run-qemu --run-renode",
    "python3 scripts/check_android_sim_boot.py",
    "python3 scripts/check_software_bsp.py aosp --require-evidence",
]


def utc_now() -> str:
    return _dt.datetime.now(_dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def provenance_safe_value(value):
    if isinstance(value, dict):
        return {key: provenance_safe_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [provenance_safe_value(item) for item in value]
    if isinstance(value, str):
        return sanitize_host_local_paths(value)
    return value


def display_path(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def command_version(command: str) -> str | None:
    path = tool_path(command)
    if path is None:
        return None
    try:
        result = subprocess.run(
            [path, "--version"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return path
    first = result.stdout.splitlines()[0].strip() if result.stdout else ""
    return f"{path} ({first})" if first else path


def command_blocker(command: str) -> str | None:
    path = tool_path(command)
    if path is None:
        return f"{command} not found on PATH"
    if command == "repo":
        try:
            result = subprocess.run(
                [path, "--version"],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            return f"{command} launcher at {path} could not run --version"
        output = result.stdout.strip()
        if result.returncode != 0:
            return f"{command} launcher at {path} failed --version"
        if "<repo not installed>" in output:
            return f"{command} launcher found at {path}, but repo is not installed"
    return None


def tool_path(command: str) -> str | None:
    found = shutil.which(command)
    if found:
        return found
    for candidate in TOOL_DEFAULT_PATHS.get(command, ()):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def smoke_command_value(name: str) -> str:
    explicit = os.environ.get(name, "")
    if explicit:
        return explicit
    default = SMOKE_COMMAND_DEFAULTS.get(name)
    if default and default.is_file() and os.access(default, os.X_OK):
        return str(default)
    return ""


def aosp_tool(aosp_dir: Path | None, *names: str) -> str | None:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    if aosp_dir is None:
        return None
    for name in names:
        candidate = aosp_dir / "out/host/linux-x86/bin" / name
        if candidate.exists():
            return str(candidate)
    return None


def path_state(path: Path) -> dict:
    return {
        "path": str(path),
        "exists": path.exists(),
        "is_file": path.is_file(),
        "is_dir": path.is_dir(),
    }


def repo_input_state() -> dict:
    required = [
        ROOT / "sw/aosp-device/import-aosp-device.sh",
        ROOT / "sw/aosp-device/capture-aosp-evidence.sh",
        ROOT / "sw/aosp-device/manifests/eliza-ai-soc-local.xml",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/AndroidProducts.mk",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/device.mk",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/eliza_ai_soc.mk",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/init.eliza.rc",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/fstab.eliza",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/manifest.xml",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/file_contexts",
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/e1_npu.te",
    ]
    missing = [str(path.relative_to(ROOT)) for path in required if not path.is_file()]
    return {
        "status": "blocked" if missing else "pass",
        "missing": missing,
        "required": [str(path.relative_to(ROOT)) for path in required],
    }


def resolve_aosp_dir(args: argparse.Namespace) -> tuple[str, str]:
    if args.aosp_dir:
        return args.aosp_dir, "arg"
    env_value = os.environ.get("AOSP_DIR", "")
    if env_value:
        return env_value, "env"
    if os.environ.get("ELIZA_DISABLE_AOSP_DIR_DEFAULTS") == "1":
        return "", "unset"
    for candidate in DEFAULT_AOSP_DIRS:
        if (candidate / "build/envsetup.sh").is_file() and (candidate / "device").is_dir():
            return str(candidate), "repo-default"
    return "", "unset"


def group_output() -> str:
    try:
        return subprocess.check_output(["id", "-nG"], text=True).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def build_report(args: argparse.Namespace) -> tuple[int, dict]:
    blockers: list[str] = []
    warnings: list[str] = []
    track_blockers: dict[str, list[str]] = {name: [] for name in EXECUTION_TRACKS}
    host_os = os.uname().sysname
    host_arch = os.uname().machine
    aosp_dir_text, aosp_dir_source = resolve_aosp_dir(args)
    aosp_dir = Path(aosp_dir_text).expanduser().resolve() if aosp_dir_text else None
    repo_inputs = repo_input_state()
    has_existing_checkout = bool(
        aosp_dir is not None
        and (aosp_dir / "build/envsetup.sh").is_file()
        and (aosp_dir / "device").is_dir()
    )

    if host_os != "Linux":
        blockers.append("Linux host required for AOSP/Cuttlefish execution")
        for track in ("build", "cuttlefish", "compatibility_intake", "qemu", "renode"):
            track_blockers[track].append("Linux host required")

    if aosp_dir is None:
        blockers.append("AOSP_DIR is not set")
        for track in track_blockers:
            track_blockers[track].append("AOSP_DIR is not set")
    else:
        if not (aosp_dir / "build/envsetup.sh").is_file():
            message = f"{aosp_dir}/build/envsetup.sh is missing"
            blockers.append(message)
            for track in track_blockers:
                track_blockers[track].append(message)
        if not (aosp_dir / "device").is_dir():
            message = f"{aosp_dir}/device is missing"
            blockers.append(message)
            for track in track_blockers:
                track_blockers[track].append(message)

    kvm = Path("/dev/kvm")
    if not kvm.exists():
        blockers.append("/dev/kvm is missing")
        track_blockers["cuttlefish"].append("/dev/kvm is missing")
    elif not os.access(kvm, os.R_OK | os.W_OK):
        blockers.append("/dev/kvm is not readable and writable by this user")
        track_blockers["cuttlefish"].append("/dev/kvm is not readable and writable")

    groups = group_output()
    group_set = set(groups.split())
    if host_os == "Linux" and not ({"kvm", "cvdnetwork"} & group_set):
        warnings.append("user is not in kvm or cvdnetwork group according to id -nG")

    required_tools = ["adb"]
    if not has_existing_checkout:
        required_tools.insert(0, "repo")
    if args.require_qemu:
        required_tools.append("qemu-system-riscv64")
    tool_blockers: dict[str, str] = {}
    for tool in required_tools:
        blocker = command_blocker(tool)
        if blocker:
            blockers.append(blocker)
            tool_blockers[tool] = blocker
    for tool, blocker in tool_blockers.items():
        if tool == "repo":
            track_blockers["import"].append(blocker)
        elif tool == "adb":
            track_blockers["cuttlefish"].append(blocker)
        elif tool == "qemu-system-riscv64":
            track_blockers["qemu"].append(blocker)
    if has_existing_checkout:
        repo_blocker = command_blocker("repo")
        if repo_blocker:
            warnings.append(
                f"{repo_blocker}; existing AOSP checkout is usable for import/build tracks"
            )

    cuttlefish_launcher = aosp_tool(aosp_dir, "launch_cvd", "cvd")
    if cuttlefish_launcher is None:
        message = (
            "Cuttlefish launcher not found; expected launch_cvd or cvd on PATH "
            "or under AOSP_DIR/out/host/linux-x86/bin"
        )
        blockers.append(message)
        track_blockers["cuttlefish"].append(message)

    if tool_path("renode") is None:
        track_blockers["renode"].append("renode not found on PATH")
    if not smoke_command_value("AOSP_QEMU_SMOKE_COMMAND"):
        track_blockers["qemu"].append("AOSP_QEMU_SMOKE_COMMAND is not set")
    if not smoke_command_value("AOSP_RENODE_SMOKE_COMMAND"):
        track_blockers["renode"].append("AOSP_RENODE_SMOKE_COMMAND is not set")
    if repo_inputs["missing"]:
        blockers.append("repo-local AOSP device inputs are incomplete")
        track_blockers["import"].extend(repo_inputs["missing"])

    imported_tree = aosp_dir / "device/eliza/eliza_ai_soc" if aosp_dir is not None else None
    import_status = {
        "repo_inputs": repo_inputs,
        "external_tree": path_state(imported_tree) if imported_tree else None,
        "check_command": 'sw/aosp-device/import-aosp-device.sh --check "$AOSP_DIR"',
        "import_command": 'sw/aosp-device/import-aosp-device.sh "$AOSP_DIR"',
    }

    tracks = {
        name: {
            "status": "blocked" if track_blockers[name] else "ready",
            "requirements": requirements,
            "blockers": track_blockers[name],
        }
        for name, requirements in EXECUTION_TRACKS.items()
    }

    report = {
        "schema": "eliza.aosp_linux_preflight.v1",
        "generated_utc": utc_now(),
        "status": "blocked" if blockers else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        "aosp_dir": str(aosp_dir) if aosp_dir else "",
        "aosp_dir_source": aosp_dir_source,
        "host": {
            "os": host_os,
            "arch": host_arch,
            "groups": groups,
            "dev_kvm": {
                "exists": kvm.exists(),
                "read_write": os.access(kvm, os.R_OK | os.W_OK) if kvm.exists() else False,
            },
        },
        "tools": {
            "repo": command_version("repo"),
            "adb": command_version("adb"),
            "qemu-system-riscv64": command_version("qemu-system-riscv64"),
            "renode": command_version("renode"),
            "cuttlefish_launcher": cuttlefish_launcher,
        },
        "smoke_commands": {
            "AOSP_QEMU_SMOKE_COMMAND": smoke_command_value("AOSP_QEMU_SMOKE_COMMAND"),
            "AOSP_RENODE_SMOKE_COMMAND": smoke_command_value("AOSP_RENODE_SMOKE_COMMAND"),
        },
        "import_status": import_status,
        "execution_tracks": tracks,
        "linux_requirements": LINUX_REQUIREMENTS,
        "handoff_commands": HANDOFF_COMMANDS,
        "blockers": blockers,
        "warnings": warnings,
        "next_step": (
            "Set AOSP_DIR to a Linux AOSP checkout with Cuttlefish/KVM available, "
            'then run sw/aosp-device/import-aosp-device.sh --check "$AOSP_DIR" '
            "and capture real evidence with sw/aosp-device/capture-aosp-evidence.sh."
        ),
        "evidence_policy": (
            "This preflight does not create docs/evidence/android logs and must not be "
            "used as AOSP build, boot, CTS, VTS, or e1-chip hardware evidence."
        ),
    }
    return (2 if blockers else 0), provenance_safe_value(report)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--aosp-dir", help="External AOSP checkout; defaults to AOSP_DIR")
    parser.add_argument(
        "--require-qemu",
        action="store_true",
        help="Also require qemu-system-riscv64 for the optional QEMU smoke track.",
    )
    parser.add_argument("--json", action="store_true", help="Print only JSON report")
    parser.add_argument(
        "--write-report",
        action="store_true",
        help=f"Write {display_path(REPORT)} for commit-ready validation records.",
    )
    args = parser.parse_args()

    rc, report = build_report(args)
    if args.write_report:
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif rc == 0:
        print("AOSP Linux preflight passed")
        print(f"claim_boundary={CLAIM_BOUNDARY}")
    else:
        print("AOSP Linux preflight BLOCKED:")
        for blocker in report["blockers"]:
            print(f"  - {blocker}")
        for warning in report["warnings"]:
            print(f"  warning: {warning}")
        print(f"claim_boundary={CLAIM_BOUNDARY}")
        print(f"next_step={report['next_step']}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
