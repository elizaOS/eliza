#!/usr/bin/env python3
import argparse
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "sw/platform/e1_platform_contract.json"
GENERATED_HEADER = ROOT / "sw/platform/generated/e1_platform_contract.h"
LINUX_DRIVER_HEADERS = (
    ROOT / "sw/linux/drivers/e1/e1_platform_contract.h",
    ROOT / "sw/linux/drivers/eliza/e1_platform_contract.h",
)
REPORT = ROOT / "build/reports/platform_contract.json"
CLAIM_BOUNDARY = "static_platform_contract_consistency_only_not_linux_or_aosp_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "aosp_boot_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


REGION_RTL_NAMES = {
    "bootrom": "boot_rom",
    "periph": "peripheral_control",
    "dma": "dma",
    "npu": "npu",
    "display": "display",
    "dram": "dram",
}

MODULE_BY_REGION = {
    "peripheral_control": ROOT / "rtl/peripherals/e1_peripherals.sv",
    "dma": ROOT / "rtl/dma/e1_dma.sv",
    "npu": ROOT / "rtl/npu/e1_npu.sv",
    "display": ROOT / "rtl/display/e1_display.sv",
}


def h(value: str) -> int:
    return int(value.replace("_", ""), 16)


def fmt_hex(value: int, width: int = 8) -> str:
    return f"0x{value:0{width}X}"


def read_text(path: Path) -> str:
    return path.read_text(errors="ignore")


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def load_contract() -> dict:
    return json.loads(CONTRACT_PATH.read_text())


def regions_by_name(contract: dict) -> dict:
    return {region["name"]: region for region in contract["e1_chip"]["regions"]}


def generate_header(contract: dict) -> str:
    e1 = contract["e1_chip"]
    qemu = contract["qemu_virt"]
    regions = regions_by_name(contract)
    boot_words = {word["name"]: h(word["value"]) for word in e1["boot_rom"]["words"]}

    lines = [
        "/* Generated from sw/platform/e1_platform_contract.json. */",
        "#ifndef E1_PLATFORM_CONTRACT_H",
        "#define E1_PLATFORM_CONTRACT_H",
        "",
        f"#define E1_CONTRACT_VERSION {contract['contract']['version']}u",
        f"#define E1_UNMAPPED_READ_VALUE {fmt_hex(h(e1['unmapped_read_value']))}u",
        f"#define E1_IMPLEMENTED_WINDOW_BYTES {e1['implemented_window_bytes']}u",
        "",
        f"#define E1_BOOT_ROM_BASE {fmt_hex(h(e1['boot_rom']['base']))}u",
        f"#define E1_BOOT_ROM_SIZE {fmt_hex(h(e1['boot_rom']['size']))}u",
        f"#define E1_BOOT_MAGIC0 {fmt_hex(boot_words['magic0'])}u",
        f"#define E1_BOOT_MAGIC1 {fmt_hex(boot_words['magic1'])}u",
        f"#define E1_BOOT_VECTOR_PLACEHOLDER {fmt_hex(boot_words['boot_vector_placeholder'])}u",
        "",
        f"#define E1_PERIPHERAL_CONTROL_BASE {fmt_hex(h(regions['peripheral_control']['base']))}u",
        f"#define E1_DMA_BASE {fmt_hex(h(regions['dma']['base']))}u",
        f"#define E1_NPU_BASE {fmt_hex(h(regions['npu']['base']))}u",
        f"#define E1_DISPLAY_BASE {fmt_hex(h(regions['display']['base']))}u",
        f"#define E1_DRAM_BASE {fmt_hex(h(regions['dram']['base']))}u",
        "",
    ]

    prefix_by_region = {
        "peripheral_control": "E1_PERIPH",
        "dma": "E1_DMA",
        "npu": "E1_NPU",
        "display": "E1_DISPLAY",
    }
    for region_name in ("peripheral_control", "dma", "npu", "display"):
        prefix = prefix_by_region[region_name]
        for reg in regions[region_name]["registers"]:
            lines.append(f"#define {prefix}_{reg['name']}_OFFSET {fmt_hex(h(reg['offset']), 2)}u")
        lines.append("")

    lines.extend(
        [
            f"#define E1_QEMU_VIRT_LOAD_ADDRESS {fmt_hex(h(qemu['load_address']))}u",
            f"#define E1_QEMU_VIRT_UART_BASE {fmt_hex(h(qemu['uart_base']))}u",
            "",
            "#endif",
            "",
        ]
    )
    return "\n".join(lines)


def check_generated_header(contract: dict, errors: list[str]) -> None:
    expected = generate_header(contract)
    if not GENERATED_HEADER.is_file():
        errors.append(f"{GENERATED_HEADER.relative_to(ROOT)} is missing")
        return
    actual = GENERATED_HEADER.read_text()
    if actual != expected:
        errors.append(
            f"{GENERATED_HEADER.relative_to(ROOT)} is stale; regenerate it from "
            f"{CONTRACT_PATH.relative_to(ROOT)}"
        )
    driver_expected = expected.replace(
        "/* Generated from sw/platform/e1_platform_contract.json. */",
        "/* Generated import copy from sw/platform/e1_platform_contract.json. */",
        1,
    )
    for driver_header in LINUX_DRIVER_HEADERS:
        if not driver_header.is_file():
            errors.append(f"{driver_header.relative_to(ROOT)} is missing")
            continue
        if driver_header.read_text() != driver_expected:
            errors.append(
                f"{driver_header.relative_to(ROOT)} is stale; regenerate it from "
                f"{GENERATED_HEADER.relative_to(ROOT)} for the external Linux import path"
            )


def check_bootrom_against_rtl(contract: dict, errors: list[str]) -> None:
    rtl = read_text(ROOT / "rtl/bootrom/e1_bootrom.sv")
    e1 = contract["e1_chip"]
    boot_size = h(e1["boot_rom"]["size"])
    word_bytes = int(e1["word_bytes"])
    require(boot_size % word_bytes == 0, "boot ROM size is not word aligned", errors)
    boot_words = boot_size // word_bytes
    require(boot_words > 0, "boot ROM size must contain at least one word", errors)
    addr_bits = (boot_words - 1).bit_length()
    require(
        f"input  logic [{addr_bits - 1}:0] addr" in rtl
        or f"input logic [{addr_bits - 1}:0] addr" in rtl,
        (
            "boot ROM RTL address width does not match contract "
            f"({boot_size} bytes / {word_bytes}-byte words -> {addr_bits} bits)"
        ),
        errors,
    )
    require(
        f"localparam int unsigned WORDS = {boot_words};" in rtl,
        f"boot ROM RTL WORDS does not match contract ({boot_words})",
        errors,
    )
    constants = {
        name: h(value)
        for name, value in re.findall(
            r"localparam\s+logic\s+\[31:0\]\s+(\w+)\s*=\s*32'h([0-9A-Fa-f_]+)",
            rtl,
        )
    }
    rtl_words = {}
    for index, value in re.findall(
        r"6'h([0-9A-Fa-f]+):\s*rdata\s*=\s*(?:32'h)?([A-Za-z0-9_]+)",
        rtl,
    ):
        if value in constants:
            resolved = constants[value]
        elif re.fullmatch(r"[0-9A-Fa-f_]+", value):
            resolved = h(value)
        else:
            resolved = -1
        rtl_words[int(index, 16) * 4] = resolved
    for index, value in re.findall(
        r"\bmem\[(\d+)\]\s*=\s*32'h([0-9A-Fa-f_]+)",
        rtl,
    ):
        rtl_words[int(index, 10) * 4] = h(value)
    for word in contract["e1_chip"]["boot_rom"]["words"]:
        offset = h(word["offset"])
        expected = h(word["value"])
        actual = rtl_words.get(offset)
        require(
            actual == expected,
            f"boot ROM {word['name']} at {fmt_hex(offset, 2)} is {fmt_hex(actual or 0)}, "
            f"contract expects {fmt_hex(expected)}",
            errors,
        )


def check_decode_against_rtl(contract: dict, errors: list[str]) -> None:
    # The MMIO address decode shared by both SoC tops lives in the extracted
    # rtl/peripherals/e1_mmio_decode.sv module; the unmapped read-data default
    # still lives in the top's read mux.
    decode = read_text(ROOT / "rtl/peripherals/e1_mmio_decode.sv")
    top = read_text(ROOT / "rtl/top/e1_soc_top.sv")
    decoded = {}
    for rtl_name, value in re.findall(
        r"assign\s+(\w+)_sel\s*=.*?mmio_addr\[31:12\]\s*==\s*20'h([0-9A-Fa-f_]+)",
        decode,
    ):
        if rtl_name in REGION_RTL_NAMES:
            decoded[REGION_RTL_NAMES[rtl_name]] = h(value) << 12
    for rtl_name, value in re.findall(
        r"assign\s+(\w+)_sel\s*=.*?mmio_addr\[31:16\]\s*==\s*16'h([0-9A-Fa-f_]+)",
        decode,
    ):
        if rtl_name in REGION_RTL_NAMES:
            decoded[REGION_RTL_NAMES[rtl_name]] = h(value) << 16

    checked_regions = set(REGION_RTL_NAMES.values())
    for name, region in regions_by_name(contract).items():
        if name not in checked_regions:
            continue
        expected = h(region["base"])
        actual = decoded.get(name)
        require(
            actual == expected,
            f"decode base for {name} is {fmt_hex(actual or 0)}, contract expects {fmt_hex(expected)}",
            errors,
        )

    require("mmio_addr[11:8] == 4'h0" in decode, "RTL implemented-window decode changed", errors)
    boot_size = h(contract["e1_chip"]["boot_rom"]["size"])
    require(
        boot_size == 0x10000 and "bootrom_sel" in decode and "mmio_addr[31:16]" in decode,
        "RTL boot ROM decode must cover the contract 64 KiB boot aperture",
        errors,
    )
    unmapped = f"{h(contract['e1_chip']['unmapped_read_value']):08X}"
    rtl_unmapped_values = {
        value.replace("_", "").upper() for value in re.findall(r"32'h([0-9A-Fa-f_]+)", top)
    }
    require(
        unmapped in rtl_unmapped_values, "RTL unmapped read value does not match contract", errors
    )


def check_register_offsets_against_rtl(contract: dict, errors: list[str]) -> None:
    regions = regions_by_name(contract)
    for region_name, path in MODULE_BY_REGION.items():
        rtl = read_text(path)
        rtl_offsets = {
            int(index, 16) * 4 for index in re.findall(r"6'h([0-9A-Fa-f]+):\s*rdata\s*=", rtl)
        }
        if region_name == "npu" and "addr[5:4] == 2'b10" in rtl and "scratch[addr[3:0]]" in rtl:
            rtl_offsets.update(range(0x80, 0xC0, 4))
        contract_offsets = set()
        for reg in regions[region_name]["registers"]:
            offset = h(reg["offset"])
            contract_offsets.add(offset)
            require(
                offset in rtl_offsets,
                f"{region_name} register {reg['name']} offset {fmt_hex(offset, 2)} is missing in {path.relative_to(ROOT)}",
                errors,
            )
        undocumented = sorted(rtl_offsets - contract_offsets)
        for offset in undocumented:
            errors.append(
                f"{region_name} RTL exposes readable offset {fmt_hex(offset, 2)} in "
                f"{path.relative_to(ROOT)} but {CONTRACT_PATH.relative_to(ROOT)} does not document it"
            )


def check_debug_contract(errors: list[str]) -> None:
    bridge = read_text(ROOT / "rtl/debug/e1_dbg_mmio_bridge.sv")
    require(
        "DBG_LAUNCH" in read_text(ROOT / "docs/arch/debug.md"),
        "docs/arch/debug.md no longer names DBG_LAUNCH",
        errors,
    )
    require(
        "addr_q[{dbg_addr[2:0], 2'b00} +: 4]" in bridge, "debug address nibble load changed", errors
    )
    require(
        "wdata_q[{dbg_addr[2:0], 2'b00} +: 4]" in bridge, "debug data nibble load changed", errors
    )
    require(
        "rdata_q[{rsel_q, 2'b00} +: 4]" in bridge, "debug readback nibble select changed", errors
    )


def check_qemu_virt_separation(contract: dict, errors: list[str]) -> None:
    qemu = contract["qemu_virt"]
    qemu_script = read_text(ROOT / "scripts/run_qemu.sh")
    renode_script = read_text(ROOT / "scripts/run_renode.sh")
    qemu_readme = read_text(ROOT / "docs/sim/qemu/README.md")
    renode_repl = read_text(ROOT / "sim/renode/eliza_e1.repl")

    require(
        "-machine virt" in qemu_script,
        "scripts/run_qemu.sh must launch qemu-system-riscv64 -machine virt",
        errors,
    )
    require(
        "qemu-virt" in qemu_script, "scripts/run_qemu.sh must label the target as qemu-virt", errors
    )
    require(
        "qemu-virt" in renode_script,
        "scripts/run_renode.sh must label the target as qemu-virt",
        errors,
    )
    require(
        "software reference only" in qemu_readme,
        "docs/sim/qemu/README.md must mark QEMU as software reference only",
        errors,
    )
    require(
        "not the e1-chip hardware ABI" in qemu_readme,
        "docs/sim/qemu/README.md must separate qemu-virt from hardware ABI",
        errors,
    )
    require(
        f"0x{h(qemu['load_address']):08x}" in renode_repl.lower(),
        "Renode RAM does not cover qemu-virt load address",
        errors,
    )
    require(
        f"0x{h(qemu['uart_base']):08x}" in renode_repl.lower(),
        "Renode UART base does not match qemu-virt contract",
        errors,
    )


def check_contract(contract: dict) -> list[str]:
    errors: list[str] = []
    e1 = contract.get("e1_chip", {})
    require(
        contract["contract"]["version"] == 1,
        "contract version must be 1 for current e1 chip",
        errors,
    )
    require(e1.get("has_cpu") is False, "e1 chip contract must state has_cpu=false", errors)
    require(
        e1.get("bus_master") == "package_debug_nibble_bridge",
        "e1 chip bus master must be the package debug nibble bridge",
        errors,
    )
    require(
        contract["qemu_virt"]["target_kind"] == "software_reference_only",
        "qemu_virt target must be marked software_reference_only",
        errors,
    )
    check_generated_header(contract, errors)
    check_bootrom_against_rtl(contract, errors)
    check_decode_against_rtl(contract, errors)
    check_register_offsets_against_rtl(contract, errors)
    check_debug_contract(errors)
    check_qemu_virt_separation(contract, errors)
    check_cpu_variant_artifacts(contract, errors)
    check_cpu_variant_consumers(contract, errors)
    check_cpu_variant_linux_contract_decode(contract, errors)
    return errors


def check_cpu_variant_artifacts(contract: dict, errors: list[str]) -> None:
    """Fail if the generated CPU-variant artifacts diverge from the contract."""
    if "e1_chip_cpu_variant" not in contract:
        errors.append(
            "e1_chip_cpu_variant section is missing from sw/platform/e1_platform_contract.json"
        )
        return
    try:
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "gen_platform_artifacts", ROOT / "scripts/gen_platform_artifacts.py"
        )
        if spec is None or spec.loader is None:
            errors.append("failed to import gen_platform_artifacts.py: no import loader")
            return
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    except Exception as exc:
        errors.append(f"failed to import gen_platform_artifacts.py: {exc}")
        return
    contents = mod.generate_all(contract)
    for kind, name in mod.ARTIFACTS.items():
        path = mod.OUT_DIR / name
        rel = path.relative_to(ROOT)
        if not path.is_file():
            errors.append(f"{rel} is missing; run `make platform-artifacts`")
            continue
        if path.read_text() != contents[kind]:
            errors.append(f"{rel} is stale; run `make platform-artifacts`")


def check_cpu_variant_consumers(contract: dict, errors: list[str]) -> None:
    """Spot-check that downstream consumers reference contract addresses.

    Keeps the cross-consumer check lightweight: every handwritten DTS that
    advertises a e1 device must use the contract base address for that
    device. RTL, kernel DTS, U-Boot, OpenSBI, and HAL configs are all
    expected to be regenerated from sw/platform/generated/ — this catches
    the case where someone forks an address into a downstream file.
    """
    if "e1_chip_cpu_variant" not in contract:
        return
    v = contract["e1_chip_cpu_variant"]
    devices = v["devices"]
    candidate_dts = [
        ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts",
        ROOT / "sw/linux/dts/eliza-e1.dts",
    ]
    for path in candidate_dts:
        if not path.is_file():
            continue
        text = read_text(path)
        for _name, dev in devices.items():
            compatible = dev["compatible"]
            if compatible not in text:
                # consumer doesn't reference this device at all; that is fine.
                continue
            base_hex = f"0x{h(dev['base']):x}"
            # accept either bare hex or a unit-address form `name@<base>`.
            unit = f"@{h(dev['base']):x}"
            if base_hex not in text and unit not in text:
                errors.append(
                    f"{path.relative_to(ROOT)} references {compatible} but does "
                    f"not use contract base {base_hex}"
                )


def check_cpu_variant_linux_contract_decode(contract: dict, errors: list[str]) -> None:
    """Check the Linux-contract AXI-Lite decoder against generated CPU ABI bases."""
    if "e1_chip_cpu_variant" not in contract:
        return
    interconnect = read_text(ROOT / "rtl/interconnect/e1_axi_lite_interconnect.sv")
    wrapper = read_text(ROOT / "rtl/interconnect/e1_linux_soc_contract.sv")
    v = contract["e1_chip_cpu_variant"]
    devs = v["devices"]

    params = {
        name: h(value)
        for name, value in re.findall(
            r"localparam\s+logic\s+\[31:0\]\s+(\w+)_BASE\s*=\s*32'h([0-9A-Fa-f_]+)",
            interconnect,
        )
    }
    expected = {
        "DRAM": h(v["dram"]["base"]),
        "INTC": h(v["plic"]["base"]),
        "DMA": h(devs["dma"]["base"]),
        "NPU": h(devs["npu"]["base"]),
        "DISP": h(devs["display"]["base"]),
    }
    for name, base in expected.items():
        actual = params.get(name)
        require(
            actual == base,
            f"Linux AXI-Lite contract {name}_BASE is {fmt_hex(actual or 0)}, "
            f"CPU variant contract expects {fmt_hex(base)}",
            errors,
        )

    for token in (
        ".npu_awvalid(",
        ".npu_arvalid(",
        ".display_awvalid(",
        ".display_arvalid(",
        "e1_npu u_npu",
        "e1_display u_display",
    ):
        require(
            token in wrapper,
            f"rtl/interconnect/e1_linux_soc_contract.sv missing Linux MMIO target token {token}",
            errors,
        )


def code_from_text(text: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    return "_".join(part for part in cleaned.split("_") if part)[:96] or "platform_contract_failure"


def write_report(errors: list[str]) -> None:
    report = report_payload(errors)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def report_payload(errors: list[str]) -> dict[str, object]:
    findings = [
        {
            "code": code_from_text(error),
            "severity": "fail",
            "message": error,
            "evidence": "sw/platform/e1_platform_contract.json",
            "next_step": "Regenerate or repair the platform contract, generated artifacts, RTL consumers, and OS DTS consumers until they agree.",
        }
        for error in errors
    ]
    report = {
        "schema": "eliza.platform_contract.v1",
        "status": "fail" if errors else "pass",
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "summary": {"findings": len(findings)},
        "findings": findings,
    }
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--print-generated-header", action="store_true")
    args = parser.parse_args()

    contract = load_contract()
    if args.print_generated_header:
        print(generate_header(contract), end="")
        return 0

    errors = check_contract(contract)
    write_report(errors)
    if errors:
        print("Platform contract check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("Platform contract check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
