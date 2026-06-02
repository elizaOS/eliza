from __future__ import annotations

import json
import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.word_valid.value = 0
    dut.word.value = 0
    dut.remap_lookup_valid.value = 0
    dut.remap_lookup_logical.value = 0
    dut.route_lookup_valid.value = 0
    dut.route_lookup_from.value = 0
    dut.route_lookup_to.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def send_word(dut, word: int) -> None:
    assert int(dut.word_ready.value) == 1
    dut.word.value = word
    dut.word_valid.value = 1
    await RisingEdge(dut.clk)
    dut.word_valid.value = 0
    await Timer(1, units="ns")


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


async def load_generated_rom(dut) -> tuple[dict, dict]:
    rom_path = required_env_path("E1X_REPAIR_ROM_JSON")
    hex_path = required_env_path("E1X_REPAIR_ROM_HEX")
    manifest_path = required_env_path("E1X_REPAIR_MANIFEST_JSON")
    rom = json.loads(rom_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    words = [
        int(line.strip(), 16)
        for line in hex_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert words == [int(word, 16) for word in rom["words"]]
    for word in words:
        await send_word(dut, word)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")
    return rom, manifest


async def lookup_remap(dut, logical: int) -> tuple[int, int]:
    dut.remap_lookup_logical.value = logical
    dut.remap_lookup_valid.value = 1
    await Timer(1, units="ns")
    hit = int(dut.remap_lookup_hit.value)
    physical = int(dut.remap_lookup_physical.value)
    dut.remap_lookup_valid.value = 0
    return hit, physical


async def lookup_route(dut, logical_from: int, logical_to: int) -> tuple[int, int, int]:
    dut.route_lookup_from.value = logical_from
    dut.route_lookup_to.value = logical_to
    dut.route_lookup_valid.value = 1
    await Timer(1, units="ns")
    hit = int(dut.route_lookup_hit.value)
    direction = int(dut.route_lookup_dir.value)
    hops = int(dut.route_lookup_hops.value)
    dut.route_lookup_valid.value = 0
    return hit, direction, hops


@cocotb.test()
async def generated_high_failure_repair_rom_programs_large_repair_state(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    rom, manifest = await load_generated_rom(dut)
    assert int(dut.load_done.value) == 1
    assert int(dut.load_error.value) == 0
    assert int(dut.overflow.value) == 0
    assert (
        int(dut.remap_count.value)
        == int(rom["remap_word_count"])
        == int(manifest["remapped_core_count"])
    )
    assert (
        int(dut.route_count.value)
        == int(rom["route_sample_word_count"])
        == len(manifest["sampled_routes"])
    )

    logical_cols = int(manifest["logical_cols"])
    physical_cols = int(manifest["physical_cols"])
    remap_indices = [
        0,
        1,
        len(manifest["remapped_cores"]) // 2,
        len(manifest["remapped_cores"]) - 1,
    ]
    for remap_index in remap_indices:
        remap = manifest["remapped_cores"][remap_index]
        logical = coord_index(remap["logical"], logical_cols)
        physical = coord_index(remap["physical"], physical_cols)
        assert await lookup_remap(dut, logical) == (1, physical)

    assert await lookup_remap(dut, 0xFFFF_FFFE) == (0, 0xFFFF_FFFE)

    route_indices = [0, len(manifest["sampled_routes"]) // 2, len(manifest["sampled_routes"]) - 1]
    for route_index in route_indices:
        route = manifest["sampled_routes"][route_index]
        logical_from = coord_index(route["logical_from"], logical_cols)
        logical_to = coord_index(route["logical_to"], logical_cols)
        assert await lookup_route(dut, logical_from, logical_to) == (
            1,
            int(route["first_hop_dir"]),
            int(route["hops"]),
        )

    assert await lookup_route(dut, 0xFFFF, 0xFFFE) == (0, 7, 0)
