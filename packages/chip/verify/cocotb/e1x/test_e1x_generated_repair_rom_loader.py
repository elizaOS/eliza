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


def _required_env_path(name: str) -> Path:
    value = os.environ.get(name)
    assert value, f"missing {name}"
    path = Path(value)
    if not path.is_absolute():
        candidates = [Path.cwd() / path, *[parent / path for parent in Path.cwd().parents]]
        path = next((candidate for candidate in candidates if candidate.is_file()), path)
    assert path.is_file(), f"{name} path does not exist: {path}"
    return path


@cocotb.test()
async def generated_high_failure_repair_rom_streams_through_rtl_loader(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    rom_json_path = _required_env_path("E1X_REPAIR_ROM_JSON")
    rom_hex_path = _required_env_path("E1X_REPAIR_ROM_HEX")
    rom = json.loads(rom_json_path.read_text(encoding="utf-8"))
    words = [int(line.strip(), 16) for line in rom_hex_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    expected_words = [int(word, 16) for word in rom["words"]]

    assert words == expected_words
    assert rom["schema"] == "eliza.e1x.repair_rom.v1"
    assert rom["word_bits"] == 64
    assert rom["header_word_count"] == 8
    assert len(words) == int(rom["total_word_count"])
    assert len(words) == int(rom["header_word_count"]) + int(rom["remap_word_count"]) + int(
        rom["route_sample_word_count"]
    )
    assert len(words) > int(rom["header_word_count"])

    observed_remaps = 0
    observed_routes = 0
    first_remap = None
    first_route = None
    for word in words:
        await send_word(dut, word)
        if int(dut.remap_valid.value):
            observed_remaps += 1
            if first_remap is None:
                first_remap = (int(dut.remap_logical.value), int(dut.remap_physical.value))
        if int(dut.route_valid.value):
            observed_routes += 1
            if first_route is None:
                first_route = (
                    int(dut.route_logical_from.value),
                    int(dut.route_logical_to.value),
                    int(dut.route_dir.value),
                    int(dut.route_hops.value),
                )

    assert int(dut.done.value) == 1
    assert int(dut.error.value) == 0
    assert int(dut.words_seen.value) == len(words)
    assert int(dut.remap_count.value) == int(rom["remap_word_count"])
    assert int(dut.route_count.value) == int(rom["route_sample_word_count"])
    assert observed_remaps == int(rom["remap_word_count"])
    assert observed_routes == int(rom["route_sample_word_count"])
    assert first_remap is not None
    assert first_route is not None
    assert 0 <= first_route[2] <= 4
    assert first_route[3] >= 1
