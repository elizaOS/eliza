from __future__ import annotations

import json
import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


def required_env_path(name: str) -> Path:
    value = os.environ.get(name)
    assert value, f"missing {name}"
    path = Path(value)
    if not path.is_absolute():
        candidates = [Path.cwd() / path, *[parent / path for parent in Path.cwd().parents]]
        path = next((candidate for candidate in candidates if candidate.is_file()), path)
    assert path.is_file(), f"{name} path does not exist: {path}"
    return path


async def reset(dut) -> None:
    dut.rst_n.value = 0
    dut.clear.value = 0
    dut.load_valid.value = 0
    dut.load_word_addr.value = 0
    dut.load_word.value = 0
    dut.read_valid.value = 0
    dut.read_word_addr.value = 0
    for _ in range(3):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def load_word(dut, addr: int, word: int) -> None:
    assert int(dut.load_ready.value) == 1
    dut.load_word_addr.value = addr
    dut.load_word.value = word
    dut.load_valid.value = 1
    await RisingEdge(dut.clk)
    dut.load_valid.value = 0
    await Timer(1, units="ns")


async def read_word(dut, addr: int) -> tuple[int, int]:
    dut.read_word_addr.value = addr
    dut.read_valid.value = 1
    await Timer(1, units="ns")
    assert int(dut.read_valid_out.value) == 1
    error = int(dut.read_error.value)
    word = int(dut.read_word.value)
    dut.read_valid.value = 0
    return error, word


@cocotb.test()
async def generated_high_failure_model_shard_loads_into_rtl_local_sram(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    shard_path = required_env_path("E1X_MODEL_SHARD_SAMPLE_JSON")
    shard = json.loads(shard_path.read_text(encoding="utf-8"))
    assert shard["schema"] == "eliza.e1x.quantized_model_shard_sample.v1"
    assert int(shard["capacity_bytes"]) == int(dut.capacity_bytes.value)
    assert int(shard["weight_shard_bytes_per_core"]) <= int(
        shard["per_core_model_capacity_bytes"]
    )
    assert shard["placement_successful"] is True

    for entry in shard["words"]:
        await load_word(dut, int(entry["word_addr"]), int(entry["word"]))

    assert int(dut.overflow.value) == 0
    assert int(dut.loaded_words.value) == int(shard["sampled_word_count"])
    assert int(dut.loaded_bytes.value) == int(shard["expected_loaded_bytes"])
    assert int(dut.checksum.value) == int(shard["expected_checksum"])

    for entry in shard["words"][:4] + shard["words"][-2:]:
        assert await read_word(dut, int(entry["word_addr"])) == (0, int(entry["word"]))
