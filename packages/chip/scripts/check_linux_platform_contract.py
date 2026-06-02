#!/usr/bin/env python3
"""Check Linux boot-facing platform contracts that are locally solvable.

This static gate does not claim Linux boot evidence. It verifies that the
checked-in DTS, Linux BSP, Buildroot, and simulator handoff files describe a
coherent path to a future boot transcript and keep reference-only paths
fail-closed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"
LINUX_DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
LINUX_KCONFIG = ROOT / "sw/linux/drivers/e1/Kconfig"
LINUX_MAKEFILE = ROOT / "sw/linux/drivers/e1/Makefile"
LINUX_SMOKE = ROOT / "sw/linux/tests/e1-mmio-smoke.c"
BUILDROOT_DEFCONFIG = ROOT / "sw/buildroot/configs/eliza_e1_defconfig"
BUILDROOT_SMOKE = ROOT / "sw/buildroot/package/e1-mmio-smoke/src/e1-mmio-smoke.c"
BUILDROOT_OVERLAY_SMOKE = ROOT / "sw/buildroot/board/eliza/e1/rootfs_overlay/usr/bin/e1-mmio-smoke"
QEMU_RUN = ROOT / "scripts/run_qemu.sh"
RENODE_RUN = ROOT / "scripts/run_renode.sh"
CHIPYARD_RUN = ROOT / "scripts/run_chipyard_eliza_linux_smoke.sh"
CHIPYARD_GENERATED_CHECK = ROOT / "scripts/check_chipyard_generated_linux_contract.py"
CVA6_CLONE = ROOT / "scripts/clone_cva6.sh"
CPU_WORK_ORDER = ROOT / "docs/project/cpu-ap-integration-work-order-2026-05-17.yaml"
LINUX_GATE = ROOT / "docs/evidence/linux-hardware-contract-gate.yaml"
REQUIRED_LINUX_GATE_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "phone_claim_allowed",
    "release_claim_allowed",
    "linux_boot_claim_allowed",
    "hardware_boot_claim_allowed",
    "silicon_evidence_claim_allowed",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def strip_dts_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//.*", "", text)


def hex_cell(value: object) -> str:
    return f"0x{int(str(value), 0):08x}"


def check_linux_dts(errors: list[str]) -> None:
    contract = json.loads(read(CONTRACT))
    variant = contract["e1_chip_cpu_variant"]
    dts = strip_dts_comments(read(LINUX_DTS))
    dts_lower = dts.lower()

    boot_requirements = {
        "RV64GC CPU node": [
            r"\bcpus\s*\{",
            r'device_type\s*=\s*"cpu"',
            r'riscv,isa\s*=\s*"rv64gc"',
        ],
        "Sv39 MMU": [r'mmu-type\s*=\s*"riscv,sv39"'],
        "memory node": [r"memory@80000000", r'device_type\s*=\s*"memory"'],
        "CLINT timer": [r"clint@2000000", r"riscv,clint0"],
        "PLIC interrupt controller": [r"interrupt-controller@c000000", r"riscv,plic0"],
        "UART console": [r"serial@10001000", r"ns16550a", r"stdout-path\s*=\s*&uart0"],
        "Linux console bootargs": [r"bootargs\s*=.*console=ttyS0"],
    }
    for label, patterns in boot_requirements.items():
        for pattern in patterns:
            require(
                re.search(pattern, dts, flags=re.I | re.S) is not None,
                f"{LINUX_DTS.relative_to(ROOT)} missing {label} marker: {pattern}",
                errors,
            )

    expected_cells = {
        "dram": hex_cell(variant["dram"]["base"]),
        "clint": hex_cell(variant["clint"]["base"]),
        "plic": hex_cell(variant["plic"]["base"]),
        "uart": hex_cell(variant["uart"]["base"]),
    }
    for name, cell in expected_cells.items():
        require(
            cell in dts_lower,
            f"{LINUX_DTS.relative_to(ROOT)} missing {name} base {cell}",
            errors,
        )

    for name, dev in variant["devices"].items():
        compat = dev["compatible"]
        base = hex_cell(dev["base"])
        irq = int(dev["irq"])
        require(compat in dts, f"{LINUX_DTS.relative_to(ROOT)} missing {compat}", errors)
        require(
            base in dts_lower,
            f"{LINUX_DTS.relative_to(ROOT)} missing {name} base {base}",
            errors,
        )
        block_match = re.search(
            rf"{re.escape(name)}@[0-9a-fA-F]+\s*\{{(?P<body>.*?)\n\s*\}};",
            dts,
            flags=re.S,
        )
        require(
            block_match is not None,
            f"{LINUX_DTS.relative_to(ROOT)} missing {name} node body",
            errors,
        )
        if block_match:
            body = block_match.group("body")
            require(
                f"interrupts = <{irq}>" in body,
                f"{LINUX_DTS.relative_to(ROOT)} {name} IRQ must be {irq}",
                errors,
            )

    for disabled in ("mmc@10050000", "serial@10051000", "wifi-pwrseq"):
        block_match = re.search(
            rf"{re.escape(disabled)}\s*\{{(?P<body>.*?)\n\s*\}};",
            dts,
            flags=re.S,
        )
        require(
            block_match is not None,
            f"{LINUX_DTS.relative_to(ROOT)} missing disabled scaffold {disabled}",
            errors,
        )
        if block_match:
            require(
                'status = "disabled"' in block_match.group("body"),
                f"{LINUX_DTS.relative_to(ROOT)} {disabled} must remain disabled until RTL/pinctrl exists",
                errors,
            )


def check_linux_drivers(errors: list[str]) -> None:
    kconfig = read(LINUX_KCONFIG)
    makefile = read(LINUX_MAKEFILE)
    dts = read(LINUX_DTS)
    driver_text = read(ROOT / "sw/linux/drivers/e1/e1-npu.c") + read(
        ROOT / "sw/linux/drivers/e1/e1-dma.c"
    )

    for compat in ("eliza,e1-npu", "eliza,e1-dma"):
        require(
            compat in dts,
            f"{LINUX_DTS.relative_to(ROOT)} missing driver compatible {compat}",
            errors,
        )
        require(compat in driver_text, f"Linux e1 drivers must bind {compat}", errors)

    for obj in re.findall(r"\+=\s*([A-Za-z0-9_-]+)\.o", makefile):
        source = LINUX_MAKEFILE.parent / f"{obj}.c"
        require(
            source.is_file(),
            f"{LINUX_MAKEFILE.relative_to(ROOT)} references missing {source.relative_to(ROOT)}",
            errors,
        )

    allowed = {"ELIZA_E1_BSP", "ELIZA_E1_NPU", "ELIZA_E1_DMA"}
    for symbol in re.findall(r"config\s+([A-Z0-9_]+)", kconfig):
        require(
            symbol in allowed,
            f"{LINUX_KCONFIG.relative_to(ROOT)} advertises unsupported symbol {symbol}",
            errors,
        )


def check_buildroot(errors: list[str]) -> None:
    defconfig = read(BUILDROOT_DEFCONFIG)
    for path in (BUILDROOT_SMOKE, LINUX_SMOKE, BUILDROOT_OVERLAY_SMOKE):
        text = read(path)
        require(
            "/dev/e1-npu" in text,
            f"{path.relative_to(ROOT)} missing /dev/e1-npu smoke marker",
            errors,
        )
        require(
            "E1_NPU_BASE=0x10020000" in text or "E1_NPU_BASE 0x10020000u" in text,
            f"{path.relative_to(ROOT)} missing E1_NPU_BASE=0x10020000 marker",
            errors,
        )
        require(
            'open("/dev/mem"' not in text and "mmap(" not in text,
            f"{path.relative_to(ROOT)} must not use /dev/mem for Linux BSP pass evidence",
            errors,
        )
    require(
        "BR2_PACKAGE_E1_MMIO_SMOKE=y" in defconfig,
        f"{BUILDROOT_DEFCONFIG.relative_to(ROOT)} must select e1-mmio-smoke",
        errors,
    )


def check_handoffs(errors: list[str]) -> None:
    handoff_tokens = {
        QEMU_RUN: (
            "qemu_virt_reference_only_not_e1_chip_rtl",
            "evidence_kind=qemu-os-boot-attempt",
        ),
        RENODE_RUN: (
            "qemu_virt_reference",
            "not e1-chip hardware ABI boot evidence",
            "scripts/run_qemu.sh --build-firmware",
        ),
        CHIPYARD_RUN: (
            "note=software reference transcripts are excluded from generated AP evidence intake",
            "LOADMEM=1 run-binary",
        ),
        CHIPYARD_GENERATED_CHECK: (
            "memory@80000000",
            "riscv,clint0",
            "riscv,plic0",
            "serial@10020000",
        ),
        CVA6_CLONE: ('CVA6_COMMIT="v5.0.0"', "external/.cva6_version", "core/cva6.sv"),
        CPU_WORK_ORDER: (
            "cva6",
            "OpenSBI and Linux boot logs are archived",
            "release_command must fail",
        ),
        LINUX_GATE: (
            "scaffold_only_linux_boot_blocked",
            "local_rtl_scaffold_is_not_linux_boot_evidence",
            "QEMU virt, Renode, or software-only logs are reference evidence",
        ),
    }
    for path, tokens in handoff_tokens.items():
        text = read(path)
        for token in tokens:
            require(
                token in text,
                f"{path.relative_to(ROOT)} missing handoff/fail-closed token {token}",
                errors,
            )
    import yaml

    gate = yaml.safe_load(read(LINUX_GATE))
    if not isinstance(gate, dict):
        errors.append(f"{LINUX_GATE.relative_to(ROOT)} must be a YAML mapping")
        return
    for key in REQUIRED_LINUX_GATE_FALSE_CLAIM_FLAGS:
        require(
            gate.get(key) is False, f"{LINUX_GATE.relative_to(ROOT)} {key} must be false", errors
        )


def main() -> int:
    errors: list[str] = []
    required_paths = (
        CONTRACT,
        LINUX_DTS,
        LINUX_KCONFIG,
        LINUX_MAKEFILE,
        LINUX_SMOKE,
        BUILDROOT_DEFCONFIG,
        BUILDROOT_SMOKE,
        BUILDROOT_OVERLAY_SMOKE,
        QEMU_RUN,
        RENODE_RUN,
        CHIPYARD_RUN,
        CHIPYARD_GENERATED_CHECK,
        CVA6_CLONE,
        CPU_WORK_ORDER,
        LINUX_GATE,
    )
    for path in required_paths:
        require(path.is_file(), f"missing {path.relative_to(ROOT)}", errors)
    if not errors:
        check_linux_dts(errors)
        check_linux_drivers(errors)
        check_buildroot(errors)
        check_handoffs(errors)

    if errors:
        print("STATUS: FAIL linux_platform_contract")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(
        "STATUS: PASS linux_platform_contract - DTS, BSP smoke, simulator handoffs, and fail-closed boundaries are coherent"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
