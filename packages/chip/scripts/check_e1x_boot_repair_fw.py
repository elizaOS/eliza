#!/usr/bin/env python3
"""Fail-closed gate for the E1X boot-time repair-ROM programming firmware.

Builds the freestanding boot core (fw/e1x/e1x_repair_boot.c) into a native
verification harness, drives it against a software model of the
e1x_repair_mmio_programmer.sv register file, and feeds it the REAL generated
scaled and real-graph repair ROM images. The harness asserts that the boot
routine streams each full image through the MMIO programmer and that the
resulting route-table model reproduces the manifest's sampled routes.

SILICON BOUNDARY: this proves the boot-time read/parse/MMIO-program logic and
route-table semantics against the real ROM image format. Fuse burning and the
OTP read port require silicon and are modelled, not implemented.

Emits build/reports/e1x_boot_repair_fw.json (schema eliza.gate_status.v1).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_boot_repair_fw.json"
BUILD_DIR = ROOT / "build/e1x_boot_repair_fw"
HARNESS_DIR = ROOT / "verify/cocotb/e1x_boot_fw"
VECTORS_HEADER = HARNESS_DIR / "e1x_boot_repair_vectors.h"

ROM_CASES = (
    {
        "id": "scaled_high_failure",
        "label": "scaled high-failure",
        "rom_json": ROOT
        / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
        "rom_hex": ROOT
        / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
        "manifest_json": ROOT
        / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_manifest.json",
    },
    {
        "id": "real_graph_normal",
        "label": "real-graph normal",
        "rom_json": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
        "rom_hex": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
        "manifest_json": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
    },
    {
        "id": "real_graph_high_failure",
        "label": "real-graph high-failure",
        "rom_json": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
        "rom_hex": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
        "manifest_json": ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
    },
)

CLAIM_BOUNDARY = (
    "E1X boot-time repair-ROM programming firmware verified against the real "
    "eliza.e1x.repair_rom.v1 image and a software model of the MMIO programmer "
    "register file; route-table semantics match e1x_repair_rom_loader.sv. Fuse "
    "burning, the OTP read port, wafer-scale programming, PD, DFT, package, and "
    "silicon are out of scope and are modelled, not implemented."
)
EVIDENCE_PATHS = [
    "fw/e1x/e1x_repair_boot.h",
    "fw/e1x/e1x_repair_boot.c",
    "fw/e1x/boot_repair_main.c",
    "fw/e1x/reset.S",
    "fw/e1x/linker.ld",
    "fw/e1x/build.sh",
    "verify/cocotb/e1x_boot_fw/native_repair_model.c",
    "rtl/e1x/e1x_repair_mmio_programmer.sv",
    "rtl/e1x/e1x_repair_rom_loader.sv",
    "rtl/e1x/e1x_repair_route_table.sv",
    "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
    "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
    "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_manifest.json",
    "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
    "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
    "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
    "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
    "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
    "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
]


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_generated_rom() -> None:
    required: list[Path] = [
        path
        for case in ROM_CASES
        for path in (case["rom_json"], case["rom_hex"], case["manifest_json"])
        if isinstance(path, Path)
    ]
    if all(path.is_file() for path in required):
        return
    subprocess.run(
        ["scripts/generate_e1x_scaled_model_evidence.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    )


def coord_index(coord: dict[str, int], cols: int) -> int:
    return int(coord["row"]) * cols + int(coord["col"])


def emit_vectors_header(case: dict[str, object]) -> dict[str, int | str]:
    """Render the real ROM words + sampled-route expectations into a C header."""
    rom_json = case["rom_json"]
    rom_hex = case["rom_hex"]
    manifest_json = case["manifest_json"]
    if (
        not isinstance(rom_json, Path)
        or not isinstance(rom_hex, Path)
        or not isinstance(
            manifest_json,
            Path,
        )
    ):
        raise TypeError("invalid E1X boot repair ROM case")
    rom = json.loads(rom_json.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_json.read_text(encoding="utf-8"))
    hex_words = [
        int(line.strip(), 16)
        for line in rom_hex.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    json_words = [int(word, 16) for word in rom["words"]]
    if hex_words != json_words:
        raise ValueError("repair ROM .hex and .json word lists disagree")

    cols = int(manifest["logical_cols"])
    routes = manifest["sampled_routes"]
    sample_indices = sorted({0, 1, len(routes) // 2, len(routes) - 1})
    samples = []
    for idx in sample_indices:
        route = routes[idx]
        samples.append(
            (
                coord_index(route["logical_from"], cols),
                coord_index(route["logical_to"], cols),
                int(route["first_hop_dir"]),
                int(route["hops"]),
            )
        )

    lines = [
        "/* GENERATED by scripts/check_e1x_boot_repair_fw.py from the real",
        " * eliza.e1x.repair_rom.v1 image and repair manifest. Do not edit. */",
        "#ifndef E1X_BOOT_REPAIR_VECTORS_H",
        "#define E1X_BOOT_REPAIR_VECTORS_H",
        "#include <stdint.h>",
        f"#define E1X_BOOT_REPAIR_ROM_WORD_COUNT {len(hex_words)}u",
        f"#define E1X_BOOT_REPAIR_REMAP_COUNT {int(rom['remap_word_count'])}u",
        f"#define E1X_BOOT_REPAIR_ROUTE_COUNT {int(rom['route_sample_word_count'])}u",
        f"#define E1X_BOOT_REPAIR_SAMPLE_COUNT {len(samples)}u",
        "static const uint64_t e1x_boot_repair_rom_words[E1X_BOOT_REPAIR_ROM_WORD_COUNT] = {",
    ]
    lines.extend(f"    0x{word:016x}ull," for word in hex_words)
    lines.append("};")
    lines.append(
        "typedef struct { uint32_t logical_from; uint32_t logical_to; uint32_t dir; uint32_t hops; }"
    )
    lines.append("    e1x_boot_repair_sample_t;")
    lines.append(
        "static const e1x_boot_repair_sample_t e1x_boot_repair_samples[E1X_BOOT_REPAIR_SAMPLE_COUNT] = {"
    )
    lines.extend(f"    {{ {f}u, {t}u, {d}u, {h}u }}," for (f, t, d, h) in samples)
    lines.append("};")
    lines.append("#endif")
    VECTORS_HEADER.write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {
        "case": str(case["id"]),
        "rom_sha256": str(rom["artifact_sha256"]),
        "rom_word_count": len(hex_words),
        "remap_count": int(rom["remap_word_count"]),
        "route_count": int(rom["route_sample_word_count"]),
        "sample_count": len(samples),
    }


def find_host_cc() -> str | None:
    for cc in ("cc", "gcc", "clang"):
        if shutil.which(cc):
            return cc
    return None


def find_riscv_cc() -> str | None:
    for cc in (
        "riscv64-unknown-elf-gcc",
        "riscv64-elf-gcc",
        "riscv-none-elf-gcc",
        "riscv64-linux-gnu-gcc",
        str(ROOT / "tools/bin/riscv64-unknown-elf-gcc"),
        str(ROOT / "external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc"),
        str(ROOT / "build/riscv-chipyard-prefix/bin/riscv64-unknown-elf-gcc"),
        str(ROOT / "build/cva6-verilator/riscv-stage/bin/riscv-none-elf-gcc"),
    ):
        if shutil.which(cc):
            return cc
    return None


def find_riscv_objcopy() -> str | None:
    for tool in (
        "riscv64-unknown-elf-objcopy",
        "riscv64-elf-objcopy",
        "riscv-none-elf-objcopy",
        "riscv64-linux-gnu-objcopy",
        str(ROOT / "tools/bin/riscv64-unknown-elf-objcopy"),
        str(ROOT / "tools/bin/riscv64-linux-gnu-objcopy"),
        str(ROOT / "external/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-objcopy"),
        str(ROOT / "build/riscv-chipyard-prefix/bin/riscv64-unknown-elf-objcopy"),
        str(ROOT / "build/cva6-verilator/riscv-stage/bin/riscv-none-elf-objcopy"),
    ):
        if shutil.which(tool):
            return tool
    return None


def build_native_harness(cc: str, case_id: str) -> tuple[bool, str, Path | None]:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    binary = BUILD_DIR / f"native_repair_model_{case_id}"
    proc = subprocess.run(
        [
            cc,
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-I",
            str(HARNESS_DIR),
            str(HARNESS_DIR / "native_repair_model.c"),
            str(ROOT / "fw/e1x/e1x_repair_boot.c"),
            "-o",
            str(binary),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:], None
    return True, f"built {binary.relative_to(ROOT)}", binary


def build_bare_metal_image(riscv_cc: str, riscv_objcopy: str) -> tuple[bool, str]:
    proc = subprocess.run(
        ["fw/e1x/build.sh"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "RISCV_CC": riscv_cc, "RISCV_OBJCOPY": riscv_objcopy},
    )
    detail = (proc.stdout.strip() or proc.stderr.strip()).splitlines()
    last = detail[-1] if detail else "no output"
    return proc.returncode == 0, last


def run_native(binary: Path) -> tuple[bool, str]:
    proc = subprocess.run([str(binary)], cwd=ROOT, text=True, capture_output=True, check=False)
    out = proc.stdout.strip().splitlines()
    last = out[-1] if out else proc.stderr.strip()
    return proc.returncode == 0, last


def main() -> int:
    ensure_generated_rom()
    checks: list[dict[str, str]] = []
    host_cc = find_host_cc()
    vector_cases: list[dict[str, int | str]] = []
    native_ok = host_cc is not None
    for case in ROM_CASES:
        case_id = str(case["id"])
        try:
            vector_info = emit_vectors_header(case)
            vector_cases.append(vector_info)
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_vectors",
                    "status": "pass",
                    "detail": f"emitted {VECTORS_HEADER.relative_to(ROOT)} ({vector_info})",
                }
            )
        except Exception as exc:  # noqa: BLE001 - surface the exact generation failure
            native_ok = False
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_vectors",
                    "status": "fail",
                    "detail": str(exc),
                }
            )
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_native_build",
                    "status": "fail",
                    "detail": "vectors not generated",
                }
            )
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_native_run",
                    "status": "fail",
                    "detail": "not run",
                }
            )
            continue

        if host_cc is None:
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_native_build",
                    "status": "blocked",
                    "detail": "install a host C compiler (cc/gcc/clang)",
                }
            )
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_native_run",
                    "status": "blocked",
                    "detail": "not run",
                }
            )
            continue

        build_ok, build_detail, binary = build_native_harness(host_cc, case_id)
        native_ok = native_ok and build_ok
        checks.append(
            {
                "id": f"e1x_boot_repair_{case_id}_native_build",
                "status": "pass" if build_ok else "fail",
                "detail": build_detail,
            }
        )
        if build_ok and binary is not None:
            run_ok, run_detail = run_native(binary)
            native_ok = native_ok and run_ok
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_native_run",
                    "status": "pass" if run_ok else "fail",
                    "detail": run_detail,
                }
            )
        else:
            native_ok = False
            checks.append(
                {
                    "id": f"e1x_boot_repair_{case_id}_native_run",
                    "status": "fail",
                    "detail": "not run",
                }
            )

    riscv_cc = find_riscv_cc()
    riscv_objcopy = find_riscv_objcopy()
    if riscv_cc is None:
        checks.append(
            {
                "id": "e1x_boot_repair_bare_metal_build",
                "status": "blocked",
                "detail": "install a RISC-V ELF compiler or set RISCV_CC",
            }
        )
    elif riscv_objcopy is None:
        checks.append(
            {
                "id": "e1x_boot_repair_bare_metal_build",
                "status": "blocked",
                "detail": "install riscv64 objcopy or set RISCV_OBJCOPY",
            }
        )
    else:
        bm_ok, bm_detail = build_bare_metal_image(riscv_cc, riscv_objcopy)
        checks.append(
            {
                "id": "e1x_boot_repair_bare_metal_build",
                "status": "pass" if bm_ok else "fail",
                "detail": bm_detail,
            }
        )

    blocked = [c for c in checks if c["status"] == "blocked"]
    failed = [c for c in checks if c["status"] == "fail"]
    status = "BLOCKED" if (failed or blocked) else "PASS"

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-boot-repair-fw",
        "status": status,
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": {
            "claim_allowed": False,
            "release_claim_allowed": False,
            "production_claim_allowed": False,
            "silicon_claim_allowed": False,
            "tapeout_claim_allowed": False,
            "phone_class_claim_allowed": False,
            "fuse_otp_claim_allowed": False,
            "firmware_release_claim_allowed": False,
        },
        "claim_boundary": CLAIM_BOUNDARY,
        "evidence_paths": EVIDENCE_PATHS,
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([c for c in checks if c["status"] == "pass"]),
            "blocked_check_count": len(blocked),
            "failing_check_count": len(failed),
            "native_verification_passed": native_ok,
            "verified_rom_case_count": len(vector_cases),
            "total_rom_word_count": sum(int(case["rom_word_count"]) for case in vector_cases),
            "max_rom_word_count": max(
                (int(case["rom_word_count"]) for case in vector_cases), default=0
            ),
            "rom_cases": vector_cases,
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if failed:
        print("BLOCKED: E1X boot repair fw failed: " + ", ".join(c["id"] for c in failed))
        return 1
    if blocked:
        print(
            "BLOCKED: E1X boot repair fw: "
            + ", ".join(f"{c['id']} ({c['detail']})" for c in blocked)
        )
        return 1
    print(f"PASS: E1X boot repair fw; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
