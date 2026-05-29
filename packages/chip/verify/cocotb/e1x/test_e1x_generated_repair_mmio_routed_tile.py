from __future__ import annotations

import json
import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

ADDR_DATA_LO = 0x08
ADDR_DATA_HI = 0x0C
ADDR_PUSH = 0x10
ADDR_COUNT = 0x14
PORTS = 5
DIR_EAST = 1
COLOR_BITS = 5
PAYLOAD_BITS = 32


def required_env_path(name: str) -> Path:
    value = os.environ.get(name)
    assert value, f"missing {name}"
    path = Path(value)
    if not path.is_absolute():
        candidates = [Path.cwd() / path, *[parent / path for parent in Path.cwd().parents]]
        path = next((candidate for candidate in candidates if candidate.is_file()), path)
    assert path.is_file(), f"{name} path does not exist: {path}"
    return path


def coord_index(coord: dict[str, int], cols: int) -> int:
    return int(coord["row"]) * cols + int(coord["col"])


def set_route(dut, color: int, in_port: int, out_port: int) -> None:
    flat = getattr(dut, "_route_table_shadow", 0)
    shift = (color * PORTS + in_port) * 3
    mask = 0b111 << shift
    flat = (flat & ~mask) | ((out_port & 0b111) << shift)
    dut._route_table_shadow = flat
    dut.route_table_flat.value = flat


def set_color(dut, port: int, color: int) -> None:
    flat = getattr(dut, "_fabric_color_shadow", 0)
    shift = port * COLOR_BITS
    mask = ((1 << COLOR_BITS) - 1) << shift
    flat = (flat & ~mask) | ((color & ((1 << COLOR_BITS) - 1)) << shift)
    dut._fabric_color_shadow = flat
    dut.fabric_color_flat.value = flat


def set_payload(dut, port: int, payload: int) -> None:
    flat = getattr(dut, "_fabric_payload_shadow", 0)
    shift = port * PAYLOAD_BITS
    mask = ((1 << PAYLOAD_BITS) - 1) << shift
    flat = (flat & ~mask) | ((payload & ((1 << PAYLOAD_BITS) - 1)) << shift)
    dut._fabric_payload_shadow = flat
    dut.fabric_payload_flat.value = flat


def set_src_dst(dut, port: int, src: int, dst: int) -> None:
    src_flat = getattr(dut, "_fabric_src_shadow", 0)
    dst_flat = getattr(dut, "_fabric_dst_shadow", 0)
    shift = port * 32
    mask = ((1 << 32) - 1) << shift
    src_flat = (src_flat & ~mask) | ((src & ((1 << 32) - 1)) << shift)
    dst_flat = (dst_flat & ~mask) | ((dst & ((1 << 32) - 1)) << shift)
    dut._fabric_src_shadow = src_flat
    dut._fabric_dst_shadow = dst_flat
    dut.fabric_src_logical_flat.value = src_flat
    dut.fabric_dst_logical_flat.value = dst_flat


def get_payload(dut, port: int) -> int:
    flat = int(dut.fabric_payload_out_flat.value)
    shift = port * PAYLOAD_BITS
    return (flat >> shift) & ((1 << PAYLOAD_BITS) - 1)


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.core_enable.value = 0
    dut.core_instr_valid.value = 0
    dut.core_instr.value = 0
    dut.repair_enable.value = 0
    dut.mmio_write_valid.value = 0
    dut.mmio_write_addr.value = 0
    dut.mmio_write_data.value = 0
    dut.mmio_read_valid.value = 0
    dut.mmio_read_addr.value = 0
    dut.port_disable.value = 0
    dut.fabric_valid.value = 0
    dut.local_src_logical.value = 0
    dut.local_dst_logical.value = 0
    dut._route_table_shadow = 0
    dut._fabric_color_shadow = 0
    dut._fabric_payload_shadow = 0
    dut._fabric_src_shadow = 0
    dut._fabric_dst_shadow = 0
    dut.route_table_flat.value = 0
    dut.fabric_color_flat.value = 0
    dut.fabric_payload_flat.value = 0
    dut.fabric_src_logical_flat.value = 0
    dut.fabric_dst_logical_flat.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def mmio_write(dut, addr: int, data: int) -> None:
    dut.mmio_write_addr.value = addr
    dut.mmio_write_data.value = data
    await Timer(1, units="ns")
    while int(dut.mmio_write_ready.value) == 0:
        await RisingEdge(dut.clk)
    dut.mmio_write_valid.value = 1
    await RisingEdge(dut.clk)
    dut.mmio_write_valid.value = 0
    await Timer(1, units="ns")


async def mmio_read(dut, addr: int) -> int:
    dut.mmio_read_addr.value = addr
    dut.mmio_read_valid.value = 1
    await Timer(1, units="ns")
    assert int(dut.mmio_read_valid_out.value) == 1
    value = int(dut.mmio_read_data.value)
    dut.mmio_read_valid.value = 0
    return value


async def push_word(dut, word: int) -> None:
    await mmio_write(dut, ADDR_DATA_LO, word & 0xFFFF_FFFF)
    await mmio_write(dut, ADDR_DATA_HI, (word >> 32) & 0xFFFF_FFFF)
    await mmio_write(dut, ADDR_PUSH, 1)


async def load_generated_rom_via_mmio(dut) -> tuple[dict, dict]:
    rom_path = required_env_path("E1X_REPAIR_ROM_JSON")
    hex_path = required_env_path("E1X_REPAIR_ROM_HEX")
    manifest_path = required_env_path("E1X_REPAIR_MANIFEST_JSON")
    rom = json.loads(rom_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    words = [int(line.strip(), 16) for line in hex_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert words == [int(word, 16) for word in rom["words"]]
    for word in words:
        await push_word(dut, word)
    for _ in range(3):
        await RisingEdge(dut.clk)
    await Timer(1, units="ns")
    return rom, manifest


@cocotb.test()
async def generated_high_failure_repair_rom_programs_tile_reroute_via_mmio(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    rom, manifest = await load_generated_rom_via_mmio(dut)
    assert int(dut.repair_load_done.value) == 1
    assert int(dut.repair_load_error.value) == 0
    assert int(dut.repair_overflow.value) == 0
    assert int(dut.repair_programmer_error.value) == 0
    assert int(dut.repair_programmer_words_pushed.value) == len(rom["words"])
    assert await mmio_read(dut, ADDR_COUNT) == len(rom["words"])
    assert int(dut.repair_route_count.value) == int(rom["route_sample_word_count"]) == len(
        manifest["sampled_routes"]
    )

    logical_cols = int(manifest["logical_cols"])
    route = next(
        sample
        for sample in manifest["sampled_routes"]
        if int(sample["first_hop_dir"]) in (0, 1, 2, 3)
    )
    expected_dir = int(route["first_hop_dir"])
    default_dir = (expected_dir + 2) % 4
    logical_from = coord_index(route["logical_from"], logical_cols)
    logical_to = coord_index(route["logical_to"], logical_cols)

    set_route(dut, color=9, in_port=DIR_EAST, out_port=default_dir)
    set_color(dut, DIR_EAST, 9)
    set_payload(dut, DIR_EAST, 0x8E1A_400D)
    set_src_dst(dut, DIR_EAST, logical_from, logical_to)
    dut.repair_enable.value = 1
    dut.port_disable.value = 1 << default_dir
    dut.fabric_valid.value = 1 << DIR_EAST
    await Timer(1, units="ns")

    assert int(dut.repair_override_used.value) & (1 << DIR_EAST)
    assert int(dut.fabric_ready.value) & (1 << DIR_EAST)
    assert int(dut.fabric_valid_out.value) & (1 << expected_dir)
    assert get_payload(dut, expected_dir) == 0x8E1A_400D
    assert int(dut.repaired_drop.value) == 0
