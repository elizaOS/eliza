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


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.mmio_write_valid.value = 0
    dut.mmio_write_addr.value = 0
    dut.mmio_write_data.value = 0
    dut.mmio_read_valid.value = 0
    dut.mmio_read_addr.value = 0
    dut.lookup_valid.value = 0
    dut.lookup_from_flat.value = 0
    dut.lookup_to_flat.value = 0
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


def set_lookup(dut, port: int, logical_from: int, logical_to: int) -> None:
    from_flat = getattr(dut, "_lookup_from_shadow", 0)
    to_flat = getattr(dut, "_lookup_to_shadow", 0)
    shift = port * 32
    mask = ((1 << 32) - 1) << shift
    from_flat = (from_flat & ~mask) | ((logical_from & ((1 << 32) - 1)) << shift)
    to_flat = (to_flat & ~mask) | ((logical_to & ((1 << 32) - 1)) << shift)
    dut._lookup_from_shadow = from_flat
    dut._lookup_to_shadow = to_flat
    dut.lookup_from_flat.value = from_flat
    dut.lookup_to_flat.value = to_flat


def get_lookup_dir(dut, port: int) -> int:
    return (int(dut.lookup_dir_flat.value) >> (port * 3)) & 0x7


def get_lookup_hops(dut, port: int) -> int:
    return (int(dut.lookup_hops_flat.value) >> (port * 16)) & 0xFFFF


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
async def generated_high_failure_repair_rom_programs_route_table_via_mmio(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    rom, manifest = await load_generated_rom_via_mmio(dut)
    assert int(dut.load_done.value) == 1
    assert int(dut.load_error.value) == 0
    assert int(dut.overflow.value) == 0
    assert int(dut.programmer_error.value) == 0
    assert int(dut.programmer_words_pushed.value) == len(rom["words"])
    assert await mmio_read(dut, ADDR_COUNT) == len(rom["words"])
    assert int(dut.remap_count.value) == int(rom["remap_word_count"])
    assert int(dut.route_count.value) == int(rom["route_sample_word_count"]) == len(
        manifest["sampled_routes"]
    )

    cols = int(manifest["logical_cols"])
    sample_indices = [0, 1, len(manifest["sampled_routes"]) // 2, len(manifest["sampled_routes"]) - 1]
    expected = []
    for port, sample_index in enumerate(sample_indices):
        route = manifest["sampled_routes"][sample_index]
        logical_from = coord_index(route["logical_from"], cols)
        logical_to = coord_index(route["logical_to"], cols)
        set_lookup(dut, port, logical_from, logical_to)
        expected.append((int(route["first_hop_dir"]), int(route["hops"])))

    dut.lookup_valid.value = 0xF
    await Timer(1, units="ns")
    assert int(dut.lookup_hit.value) == 0xF
    for port, (direction, hops) in enumerate(expected):
        assert get_lookup_dir(dut, port) == direction
        assert get_lookup_hops(dut, port) == hops
