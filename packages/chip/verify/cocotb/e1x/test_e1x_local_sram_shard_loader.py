from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

LOCAL_SRAM_BYTES = 48 * 1024
LOCAL_SRAM_WORDS = LOCAL_SRAM_BYTES // 4


def packed_w4_word(base: int) -> int:
    word = 0
    for lane in range(8):
        word |= ((base + lane) & 0xF) << (lane * 4)
    return word


def checksum_step(checksum: int, addr: int, word: int) -> int:
    rotated = ((checksum << 1) | (checksum >> 31)) & 0xFFFF_FFFF
    return (rotated ^ word ^ addr) & 0xFFFF_FFFF


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
async def local_sram_loader_accepts_quantized_weight_shard_and_reports_checksum(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    expected_checksum = 0
    expected_words = {}
    for addr in range(16):
        word = packed_w4_word(addr)
        expected_words[addr] = word
        expected_checksum = checksum_step(expected_checksum, addr, word)
        await load_word(dut, addr, word)

    last_addr = LOCAL_SRAM_WORDS - 1
    last_word = 0xF0E1_D2C3
    expected_words[last_addr] = last_word
    expected_checksum = checksum_step(expected_checksum, last_addr, last_word)
    await load_word(dut, last_addr, last_word)

    assert int(dut.capacity_bytes.value) == LOCAL_SRAM_BYTES
    assert int(dut.loaded_words.value) == 17
    assert int(dut.loaded_bytes.value) == 68
    assert int(dut.checksum.value) == expected_checksum
    assert int(dut.overflow.value) == 0

    for addr, word in expected_words.items():
        assert await read_word(dut, addr) == (0, word)


@cocotb.test()
async def local_sram_loader_flags_out_of_capacity_shard_write_and_clear_recovers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await load_word(dut, LOCAL_SRAM_WORDS - 1, 0x1234_5678)
    assert int(dut.overflow.value) == 0
    assert int(dut.loaded_words.value) == 1

    await load_word(dut, LOCAL_SRAM_WORDS, 0xDEAD_BEEF)
    assert int(dut.overflow.value) == 1
    assert int(dut.loaded_words.value) == 1
    assert await read_word(dut, LOCAL_SRAM_WORDS) == (1, 0)

    dut.clear.value = 1
    await RisingEdge(dut.clk)
    dut.clear.value = 0
    await Timer(1, units="ns")

    assert int(dut.overflow.value) == 0
    assert int(dut.loaded_words.value) == 0
    assert int(dut.loaded_bytes.value) == 0
    assert int(dut.checksum.value) == 0
