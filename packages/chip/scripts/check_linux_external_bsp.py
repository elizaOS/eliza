#!/usr/bin/env python3
"""Machine-readable status for external Linux BSP evidence capture.

This checker does not patch or build the external tree. It reports whether a
candidate Linux checkout exists, whether the Eliza BSP appears imported,
which host tools are available, and the exact commands that produce the three
minimum Linux evidence logs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "docs/evidence/linux/linux-external-bsp-status.json"

EVIDENCE = {
    "linux_kernel_build": "docs/evidence/linux/eliza_e1_kernel_build.log",
    "linux_dtb_check": "docs/evidence/linux/eliza_e1_dtb_check.log",
    "linux_mmio_smoke": "docs/evidence/linux/e1-mmio-smoke.log",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def candidate_linux_tree(arg: str | None) -> Path:
    value = arg or os.environ.get("LINUX_TREE") or os.environ.get("LINUX_DIR")
    if value:
        return Path(value).expanduser()
    return ROOT / "external/linux"


def is_linux_tree(path: Path) -> bool:
    return (path / "Kconfig").is_file() and (path / "drivers").is_dir() and (path / "arch").is_dir()


def tool_status() -> dict[str, Any]:
    compilers = [
        os.environ.get("CROSS_COMPILE", "") + "gcc" if os.environ.get("CROSS_COMPILE") else "",
        "riscv64-linux-gnu-gcc",
        "riscv64-unknown-linux-gnu-gcc",
        "riscv64-unknown-elf-gcc",
    ]
    found_compiler = next((tool for tool in compilers if tool and shutil.which(tool)), "")
    make_path = shutil.which("make") or ""
    make_version = ""
    make_ok = False
    if make_path:
        completed = subprocess.run(
            [make_path, "--version"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        first = completed.stdout.splitlines()[0] if completed.stdout else ""
        make_version = first
        match = re.search(r"GNU Make\s+([0-9]+)\.([0-9]+)", first)
        if match:
            major = int(match.group(1))
            minor = int(match.group(2))
            make_ok = (major, minor) >= (3, 82)
    return {
        "make": make_path,
        "make_version": make_version,
        "make_version_ok": make_ok,
        "dtc": shutil.which("dtc") or "",
        "riscv_compiler": found_compiler,
        "cross_compile": os.environ.get("CROSS_COMPILE", ""),
    }


def path_state(path: Path) -> dict[str, Any]:
    return {"path": str(path), "exists": path.exists(), "is_file": path.is_file()}


def imported_state(linux: Path) -> dict[str, Any]:
    required = {
        "driver_kconfig": linux / "drivers/misc/eliza-e1/Kconfig",
        "driver_makefile": linux / "drivers/misc/eliza-e1/Makefile",
        "npu_driver": linux / "drivers/misc/eliza-e1/e1-npu.c",
        "dma_driver": linux / "drivers/misc/eliza-e1/e1-dma.c",
        "platform_header": linux / "drivers/misc/eliza-e1/e1_platform_contract.h",
        "board_dts": linux / "arch/riscv/boot/dts/eliza/eliza-e1.dts",
    }
    optional = {
        "board_dts_makefile": linux / "arch/riscv/boot/dts/eliza/Makefile",
        "npu_binding": linux / "Documentation/devicetree/bindings/eliza/eliza,e1-npu.yaml",
        "dma_binding": linux / "Documentation/devicetree/bindings/eliza/eliza,e1-dma.yaml",
        "display_binding": linux / "Documentation/devicetree/bindings/eliza/eliza,e1-display.yaml",
    }
    required_status = {name: path_state(path) for name, path in required.items()}
    optional_status = {name: path_state(path) for name, path in optional.items()}
    missing_required = [name for name, item in required_status.items() if not item["is_file"]]
    missing_optional = [name for name, item in optional_status.items() if not item["is_file"]]
    text_checks: dict[str, bool] = {}
    misc_kconfig = linux / "drivers/misc/Kconfig"
    misc_makefile = linux / "drivers/misc/Makefile"
    riscv_dts_makefile = linux / "arch/riscv/boot/dts/Makefile"
    text_checks["drivers_misc_kconfig_sources_eliza"] = (
        misc_kconfig.is_file()
        and 'source "drivers/misc/eliza-e1/Kconfig"' in misc_kconfig.read_text(errors="replace")
    )
    text_checks["drivers_misc_makefile_links_eliza"] = (
        misc_makefile.is_file()
        and "obj-$(CONFIG_ELIZA_E1_BSP) += eliza-e1/" in misc_makefile.read_text(errors="replace")
    )
    text_checks["riscv_dts_makefile_links_eliza"] = (
        riscv_dts_makefile.is_file()
        and "subdir-y += eliza" in riscv_dts_makefile.read_text(errors="replace")
    )
    return {
        "status": "imported"
        if not missing_required and all(text_checks.values())
        else "not_imported",
        "required": required_status,
        "optional": optional_status,
        "missing_required": missing_required,
        "missing_optional": missing_optional,
        "text_checks": text_checks,
    }


def evidence_state(path: Path) -> dict[str, Any]:
    blocked = path.with_suffix(path.suffix + ".BLOCKED")
    if path.is_file() and path.stat().st_size > 0:
        return {"state": "present", "path": rel(path), "bytes": path.stat().st_size}
    if blocked.is_file():
        text = blocked.read_text(encoding="utf-8", errors="replace").strip()
        return {
            "state": "blocked",
            "path": rel(path),
            "blocked_marker": rel(blocked),
            "reason": text.splitlines()[0] if text else "",
        }
    return {"state": "missing", "path": rel(path), "blocked_marker": rel(blocked)}


def commands(linux: Path) -> dict[str, str]:
    linux_text = str(linux)
    return {
        "import_check": f"sw/linux/scripts/import-linux-bsp.sh --check {linux_text}",
        "import": f"sw/linux/scripts/import-linux-bsp.sh {linux_text}",
        "configure": f"cd {linux_text} && make ARCH=riscv eliza_e1.config olddefconfig",
        "kernel_build": f"sw/linux/scripts/capture-linux-bsp-evidence.sh {linux_text} kernel-build",
        "dtb_check": f"sw/linux/scripts/capture-linux-bsp-evidence.sh {linux_text} dtb-check",
        "mmio_smoke": (
            "E1_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-mmio-smoke' "
            f"sw/linux/scripts/capture-linux-bsp-evidence.sh {linux_text} smoke"
        ),
    }


def build_report(linux: Path) -> dict[str, Any]:
    tools = tool_status()
    tree_exists = linux.exists()
    tree_ok = is_linux_tree(linux)
    imported = imported_state(linux) if tree_ok else {"status": "missing_tree"}
    evidence = {name: evidence_state(ROOT / path) for name, path in EVIDENCE.items()}

    blockers: list[dict[str, str]] = []
    if not tree_exists:
        blockers.append({"id": "external_linux_tree_missing", "detail": str(linux)})
    elif not tree_ok:
        blockers.append({"id": "external_linux_tree_invalid", "detail": str(linux)})
    elif imported.get("status") != "imported":
        blockers.append(
            {
                "id": "external_linux_bsp_not_imported",
                "detail": "run import command before kernel-build or dtb-check evidence capture",
            }
        )
    if not tools["riscv_compiler"] and not tools["cross_compile"]:
        blockers.append(
            {
                "id": "riscv_cross_compiler_missing",
                "detail": "set CROSS_COMPILE=... or install a riscv64 Linux compiler",
            }
        )
    if not tools["make_version_ok"]:
        blockers.append(
            {
                "id": "gnu_make_too_old_or_missing",
                "detail": tools["make_version"] or "make not found",
            }
        )
    for name, state in evidence.items():
        if state["state"] != "present":
            blockers.append({"id": f"{name}_evidence_{state['state']}", "detail": state["path"]})

    return {
        "schema": "eliza.linux_external_bsp_status.v1",
        "status": "blocked" if blockers else "pass",
        "claim_boundary": "status_only_not_linux_boot_evidence",
        "linux_tree": str(linux),
        "linux_tree_valid": tree_ok,
        "tools": tools,
        "imported_bsp": imported,
        "producer_commands": commands(linux),
        "evidence": evidence,
        "blockers": blockers,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("linux_tree", nargs="?")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--require-pass", action="store_true")
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"status report path (default: {rel(REPORT)})",
    )
    args = parser.parse_args(argv)

    report_path = Path(args.report).expanduser()
    if not report_path.is_absolute():
        report_path = ROOT / report_path
    report = build_report(candidate_linux_tree(args.linux_tree))
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"STATUS: {report['status'].upper()} linux.external_bsp_status")
        print(f"  report: {rel(report_path)}")
        for key, value in report["producer_commands"].items():
            print(f"  command.{key}: {value}")
        for blocker in report["blockers"]:
            print(f"  - {blocker['id']}: {blocker['detail']}")
    if report["status"] == "pass":
        return 0
    return 2 if args.require_pass else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
