import json
import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))
from compiler.runtime.e1_npu_runtime import E1NpuRuntime, golden_gemm_s8  # noqa: E402


async def reset(dut):
    dut.rst_n.value = 0
    dut.valid.value = 0
    dut.write.value = 0
    dut.addr.value = 0
    dut.wdata.value = 0
    if hasattr(dut, "m_axil_arready"):
        dut.m_axil_arready.value = 0
        dut.m_axil_rvalid.value = 0
        dut.m_axil_rdata.value = 0
        dut.m_axil_rresp.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def write_reg(dut, addr, data):
    dut.addr.value = addr
    dut.wdata.value = data
    dut.write.value = 1
    dut.valid.value = 1
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    dut.write.value = 0
    await Timer(1, units="ns")


async def read_reg(dut, addr):
    dut.addr.value = addr
    dut.write.value = 0
    dut.valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.rdata.value)
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    await Timer(1, units="ns")
    return value


async def poll_done(dut, cycles=32):
    for _ in range(cycles):
        status = await read_reg(dut, 3)
        if status & 0x2:
            return status
    raise AssertionError("timeout waiting for NPU operation")


async def run_scalar(dut, opcode, op_a, op_b, acc=0):
    await write_reg(dut, 3, 2)
    await write_reg(dut, 0, op_a)
    await write_reg(dut, 1, op_b)
    await write_reg(dut, 5, acc)
    await write_reg(dut, 4, opcode)
    await write_reg(dut, 3, 1)
    assert await poll_done(dut) == 0x2
    return await read_reg(dut, 2), await read_reg(dut, 6)


def pack_s8(values):
    word = 0
    for index, value in enumerate(values):
        word |= (value & 0xFF) << (8 * index)
    return word


def pack_s4(values):
    word = 0
    for index, value in enumerate(values):
        word |= (value & 0xF) << (4 * index)
    return word


async def runtime_write32(dut, addr, data):
    assert 0x1002_0000 <= addr < 0x1002_1000
    await write_reg(dut, (addr - 0x1002_0000) >> 2, data)


async def runtime_read32(dut, addr):
    assert 0x1002_0000 <= addr < 0x1002_1000
    return await read_reg(dut, (addr - 0x1002_0000) >> 2)


async def runtime_run(dut, opcode, a, b, acc=0):
    await runtime_write32(dut, E1NpuRuntime.OP_A, a & 0xFFFF_FFFF)
    await runtime_write32(dut, E1NpuRuntime.OP_B, b & 0xFFFF_FFFF)
    await runtime_write32(dut, E1NpuRuntime.ACC, acc & 0xFFFF_FFFF)
    await runtime_write32(dut, E1NpuRuntime.OPCODE, opcode & 0xF)
    await runtime_write32(dut, E1NpuRuntime.CTRL_STATUS, 2)
    await runtime_write32(dut, E1NpuRuntime.CTRL_STATUS, 1)
    for _ in range(1024):
        status = await runtime_read32(dut, E1NpuRuntime.CTRL_STATUS)
        if status & 0x4:
            raise RuntimeError("e1 NPU rejected runtime command")
        if status & 0x2:
            return await runtime_read32(dut, E1NpuRuntime.RESULT)
    raise TimeoutError("e1 NPU runtime command did not complete")


async def runtime_write_scratch(dut, offset, data):
    scratch = bytearray()
    for word in range(E1NpuRuntime.SCRATCH_BYTES // 4):
        value = await runtime_read32(dut, E1NpuRuntime.SCRATCH + word * 4)
        scratch.extend(value.to_bytes(4, "little"))
    scratch[offset : offset + len(data)] = data
    for word in range(E1NpuRuntime.SCRATCH_BYTES // 4):
        value = int.from_bytes(scratch[word * 4 : word * 4 + 4], "little")
        await runtime_write32(dut, E1NpuRuntime.SCRATCH + word * 4, value)


async def runtime_read_scratch(dut, offset, size):
    data = bytearray()
    for word in range(E1NpuRuntime.SCRATCH_BYTES // 4):
        value = await runtime_read32(dut, E1NpuRuntime.SCRATCH + word * 4)
        data.extend(value.to_bytes(4, "little"))
    return bytes(data[offset : offset + size])


async def runtime_gemm_s8(dut, a, b):
    m = len(a)
    k = len(a[0]) if m else 0
    n = len(b[0]) if b else 0
    a_base = 0
    b_base = m * k
    c_base = (b_base + k * n + 3) & ~3
    c_bytes = m * n * 4
    a_bytes = bytes(value & 0xFF for row in a for value in row)
    b_bytes = bytes(b[row][col] & 0xFF for row in range(k) for col in range(n))

    await runtime_write32(dut, E1NpuRuntime.PERF_ERRORS, 1)
    await runtime_write_scratch(dut, a_base, a_bytes)
    await runtime_write_scratch(dut, b_base, b_bytes)
    await runtime_write_scratch(dut, c_base, bytes(c_bytes))
    await runtime_write32(dut, E1NpuRuntime.GEMM_CFG, m | (n << 8) | (k << 16))
    await runtime_write32(dut, E1NpuRuntime.GEMM_BASE, a_base | (b_base << 8) | (c_base << 16))
    await runtime_write32(dut, E1NpuRuntime.GEMM_STRIDE, k | (n << 8) | ((n * 4) << 16))
    await runtime_write32(dut, E1NpuRuntime.OPCODE, E1NpuRuntime.OP_GEMM_S8)
    await runtime_write32(dut, E1NpuRuntime.CTRL_STATUS, 2)
    await runtime_write32(dut, E1NpuRuntime.CTRL_STATUS, 1)
    for _ in range(1024):
        status = await runtime_read32(dut, E1NpuRuntime.CTRL_STATUS)
        if status & 0x4:
            raise RuntimeError("e1 NPU rejected runtime GEMM command")
        if status & 0x2:
            raw = await runtime_read_scratch(dut, c_base, c_bytes)
            return [
                [
                    int.from_bytes(
                        raw[(r * n + c) * 4 : (r * n + c + 1) * 4], "little", signed=True
                    )
                    for c in range(n)
                ]
                for r in range(m)
            ]
    raise TimeoutError("e1 NPU runtime GEMM command did not complete")


async def descriptor_read_responder(dut, memory):
    pending = None
    while True:
        await RisingEdge(dut.clk)
        if pending is None:
            dut.m_axil_rvalid.value = 0
            dut.m_axil_rdata.value = 0
            dut.m_axil_rresp.value = 0
        else:
            dut.m_axil_rvalid.value = 1
            dut.m_axil_rdata.value = pending
            dut.m_axil_rresp.value = 0
            pending = None

        if int(dut.m_axil_arvalid.value):
            dut.m_axil_arready.value = 1
            pending = memory.get(int(dut.m_axil_araddr.value), 0)
        else:
            dut.m_axil_arready.value = 0


@cocotb.test()
async def npu_scalar_opcodes_match_expected_results(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    result, result_hi = await run_scalar(dut, 0, 0xFFFF_FFFF, 2)
    assert result == 1
    assert result_hi == 0

    result, result_hi = await run_scalar(dut, 1, 3, 5)
    assert result == 0xFFFF_FFFE
    assert result_hi == 0

    result, result_hi = await run_scalar(dut, 2, 0xFFFF_FFFF, 2)
    assert result == 0xFFFF_FFFE
    assert result_hi == 1

    result, result_hi = await run_scalar(dut, 3, 0x0000_FFFE, 7, 20)
    assert result == 6
    assert result_hi == 0

    result, result_hi = await run_scalar(
        dut,
        4,
        pack_s8([1, -2, 3, -4]),
        pack_s8([5, 6, -7, -8]),
        9,
    )
    assert result == 13
    assert result_hi == 0

    result, result_hi = await run_scalar(
        dut,
        7,
        pack_s4([1, -2, 3, -4, 5, -6, 7, -8]),
        pack_s4([1, 2, -3, 4, 5, -6, 7, -8]),
    )
    assert result == 146
    assert result_hi == 0

    result, _ = await run_scalar(dut, 5, 0x8000_0000, 0x7FFF_FFFF)
    assert result == 0x8000_0000

    result, _ = await run_scalar(dut, 6, 0x8000_0000, 0x7FFF_FFFF)
    assert result == 0x7FFF_FFFF


@cocotb.test()
async def npu_rejects_invalid_opcode_and_clears_error_irq(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 4, 0xF)
    assert await read_reg(dut, 4) == 0xF
    await write_reg(dut, 3, 1)
    assert await poll_done(dut) == 0x6
    assert int(dut.irq.value) == 1
    assert await read_reg(dut, 0x17) == 1

    await write_reg(dut, 3, 2)
    assert await read_reg(dut, 3) == 0
    assert int(dut.irq.value) == 0


@cocotb.test()
async def npu_busy_launch_is_ignored_until_current_operation_completes(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0, 0xFFFF_FFFF)
    await write_reg(dut, 1, 0xFFFF_FFFE)
    await write_reg(dut, 4, 2)
    await write_reg(dut, 3, 1)
    busy = await read_reg(dut, 7)
    assert busy & 0x7

    await write_reg(dut, 3, 1)
    assert await poll_done(dut) == 0x2
    assert await read_reg(dut, 2) == 2
    assert await read_reg(dut, 6) == 0xFFFF_FFFD

    await write_reg(dut, 0, 10)
    await write_reg(dut, 1, 20)
    await write_reg(dut, 4, 0)
    await write_reg(dut, 3, 1)

    assert await poll_done(dut) == 0x2
    assert await read_reg(dut, 2) == 30
    assert await read_reg(dut, 6) == 0


@cocotb.test()
async def npu_gemm_invalid_config_reports_error_without_touching_scratch(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0x20, 0xA5A5_5A5A)
    await write_reg(dut, 0x08, 0)  # zero dimensions are invalid
    await write_reg(dut, 0x09, 0)
    await write_reg(dut, 0x0A, 0)
    await write_reg(dut, 0x04, 8)
    await write_reg(dut, 0x03, 1)

    assert await poll_done(dut) == 0x6
    assert await read_reg(dut, 0x17) == 1
    assert await read_reg(dut, 0x20) == 0xA5A5_5A5A


@cocotb.test()
async def npu_descriptor_timeout_engine_faults_stalled_memory_fetch(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0x10, 0x4000)
    await write_reg(dut, 0x11, 0)
    await write_reg(dut, 0x12, 1)
    await write_reg(dut, 0x0C, 1)
    await write_reg(dut, 0x03, 2)
    await write_reg(dut, 0x03, 1)

    assert await poll_done(dut, cycles=200) == 0x6
    assert await read_reg(dut, 0x10) == 0x4000
    assert await read_reg(dut, 0x11) == 0
    assert await read_reg(dut, 0x12) == 1
    desc_status = await read_reg(dut, 0x13)
    assert (desc_status & 0xFF) == 0x0C
    assert ((desc_status >> 9) & 0x7) == 1
    assert await read_reg(dut, 0x0B) == 1
    assert await read_reg(dut, 0x17) == 1
    assert await read_reg(dut, 0x18) >= 128
    assert int(dut.irq.value) == 1

    await write_reg(dut, 0x03, 2)
    assert await read_reg(dut, 0x03) == 0
    assert (await read_reg(dut, 0x13) & 0xFF) == 0


@cocotb.test()
async def npu_descriptor_empty_and_unaligned_base_report_specific_status(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write_reg(dut, 0x10, 0x2000)
    await write_reg(dut, 0x11, 2)
    await write_reg(dut, 0x12, 2)
    await write_reg(dut, 0x0C, 1)
    await write_reg(dut, 0x03, 1)
    assert await poll_done(dut) == 0x6
    assert await read_reg(dut, 0x13) == (2 << 9) | 0x1

    await write_reg(dut, 0x03, 2)
    await write_reg(dut, 0x10, 0x2002)
    await write_reg(dut, 0x11, 2)
    await write_reg(dut, 0x12, 3)
    await write_reg(dut, 0x03, 1)
    assert await poll_done(dut) == 0x6
    desc_status = await read_reg(dut, 0x13)
    assert (desc_status & 0xFF) == 0x04
    assert ((desc_status >> 9) & 0x7) == 3


@cocotb.test()
async def npu_descriptor_fetch_launches_scalar_op_and_advances_tail(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    reader = cocotb.start_soon(
        descriptor_read_responder(
            dut,
            {
                0x4000: 0x8000_0000,  # valid owner, ADD
                0x4004: 7,
                0x4008: 11,
                0x400C: 0,
            },
        )
    )
    await write_reg(dut, 0x10, 0x4000)
    await write_reg(dut, 0x11, 1)
    await write_reg(dut, 0x12, 0)
    await write_reg(dut, 0x0C, 1)
    await write_reg(dut, 0x03, 1)

    done_status = await poll_done(dut, cycles=64)
    desc_status = await read_reg(dut, 0x13)
    assert done_status == 0x2, f"status=0x{done_status:08x} desc_status=0x{desc_status:08x}"
    reader.kill()
    assert await read_reg(dut, 0x02) == 18
    assert await read_reg(dut, 0x11) == 1
    assert await read_reg(dut, 0x12) == 1
    assert await read_reg(dut, 0x13) == 0x2
    assert await read_reg(dut, 0x19) == 16
    assert await read_reg(dut, 0x1A) == 0
    assert await read_reg(dut, 0x1B) == 4
    assert await read_reg(dut, 0x1C) == 0
    assert await read_reg(dut, 0x16) == 1
    assert await read_reg(dut, 0x17) == 0


@cocotb.test()
async def npu_descriptor_streams_tensor_tile_into_scratchpad_and_runs_gemm(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    a = [[1, -2, 3], [4, 5, -6]]
    b = [[7, -8], [9, 10], [-11, 12]]
    a_bytes = bytes(value & 0xFF for row in a for value in row)
    b_bytes = bytes(b[row][col] & 0xFF for row in range(3) for col in range(2))
    tensor = a_bytes + b_bytes
    tensor_words = {
        0x5000 + index * 4: int.from_bytes(tensor[index * 4 : index * 4 + 4], "little")
        for index in range(3)
    }
    descriptor = {
        0x4000: 0x8000_0000 | E1NpuRuntime.OP_GEMM_S8 | (1 << 8) | (0 << 16) | (len(tensor) << 24),
        0x4004: 0x5000,
        0x4008: 0,
        0x400C: 0,
    }
    reader = cocotb.start_soon(descriptor_read_responder(dut, descriptor | tensor_words))

    await write_reg(dut, 0x17, 1)
    await write_reg(dut, 0x08, 2 | (2 << 8) | (3 << 16))
    await write_reg(dut, 0x09, 0 | (6 << 8) | (12 << 16))
    await write_reg(dut, 0x0A, 3 | (2 << 8) | (8 << 16))
    await write_reg(dut, 0x10, 0x4000)
    await write_reg(dut, 0x11, 1)
    await write_reg(dut, 0x12, 0)
    await write_reg(dut, 0x0C, 1)
    await write_reg(dut, 0x03, 1)

    done_status = await poll_done(dut, cycles=128)
    desc_status = await read_reg(dut, 0x13)
    assert done_status == 0x2, f"status=0x{done_status:08x} desc_status=0x{desc_status:08x}"
    reader.kill()
    assert await read_reg(dut, 0x12) == 1
    assert await read_reg(dut, 0x13) == 0x2
    assert await read_reg(dut, 0x19) == 28
    assert await read_reg(dut, 0x1A) == 0
    assert await read_reg(dut, 0x1B) == 7
    assert await read_reg(dut, 0x1C) == 0
    assert await read_reg(dut, 0x15) == 12
    assert await read_reg(dut, 0x17) == 0

    raw = bytearray()
    for word in range(16):
        raw.extend((await read_reg(dut, 0x20 + word)).to_bytes(4, "little"))
    observed = [
        [
            int.from_bytes(
                raw[12 + (row * 2 + col) * 4 : 12 + (row * 2 + col + 1) * 4], "little", signed=True
            )
            for col in range(2)
        ]
        for row in range(2)
    ]
    assert observed == golden_gemm_s8(a, b)


@cocotb.test()
async def npu_descriptor_requires_valid_owner_bit_and_rejects_writeback_request(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    reader = cocotb.start_soon(
        descriptor_read_responder(
            dut,
            {
                0x4000: 0x0000_0000,  # missing valid owner bit
                0x4004: 7,
                0x4008: 11,
                0x400C: 0,
                0x4010: 0xC000_0000,  # valid owner + unsupported writeback request, ADD
                0x4014: 7,
                0x4018: 11,
                0x401C: 0,
            },
        )
    )

    await write_reg(dut, 0x10, 0x4000)
    await write_reg(dut, 0x11, 1)
    await write_reg(dut, 0x12, 0)
    await write_reg(dut, 0x0C, 1)
    await write_reg(dut, 0x03, 1)

    assert await poll_done(dut, cycles=64) == 0x6
    desc_status = await read_reg(dut, 0x13)
    assert (desc_status & 0xFF) == 0x44
    assert await read_reg(dut, 0x12) == 0
    assert await read_reg(dut, 0x1A) == 0
    assert await read_reg(dut, 0x1C) == 0

    await write_reg(dut, 0x03, 2)
    await write_reg(dut, 0x12, 1)
    await write_reg(dut, 0x11, 2)
    await write_reg(dut, 0x03, 1)

    assert await poll_done(dut, cycles=64) == 0x6
    reader.kill()
    desc_status = await read_reg(dut, 0x13)
    assert (desc_status & 0xFF) == 0x84
    assert ((desc_status >> 9) & 0x7) == 1
    assert await read_reg(dut, 0x12) == 1
    assert await read_reg(dut, 0x1A) == 0
    assert await read_reg(dut, 0x1C) == 0


@cocotb.test()
async def npu_runtime_abi_sequence_matches_rtl_and_writes_coverage(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    scalar_cases = [
        ("add", E1NpuRuntime.OP_ADD, 7, 11, 0, 18),
        ("sub", E1NpuRuntime.OP_SUB, 7, 11, 0, 0xFFFF_FFFC),
        ("mul_lo", E1NpuRuntime.OP_MUL_LO, 0xFFFF_FFFE, 3, 0, 0xFFFF_FFFA),
        ("mac_s16", E1NpuRuntime.OP_MAC_S16, 0x0000_FFFE, 9, 30, 12),
        (
            "dot4_s8",
            E1NpuRuntime.OP_DOT4_S8,
            pack_s8([3, -4, 5, -6]),
            pack_s8([-7, 8, -9, 10]),
            1,
            0xFFFF_FF63,
        ),
        (
            "dot8_s4",
            E1NpuRuntime.OP_DOT8_S4,
            pack_s4([1, -2, 3, -4, 5, -6, 7, -8]),
            pack_s4([1, 2, -3, 4, 5, -6, 7, -8]),
            0,
            146,
        ),
        ("max_u32", E1NpuRuntime.OP_MAX_U32, 0x0000_0001, 0xFFFF_FFFE, 0, 0xFFFF_FFFE),
        ("min_u32", E1NpuRuntime.OP_MIN_U32, 0x0000_0001, 0xFFFF_FFFE, 0, 1),
    ]

    covered_opcodes = set()
    for _, opcode, a, b, acc, expected in scalar_cases:
        observed = await runtime_run(dut, opcode, a, b, acc)
        assert observed == expected
        covered_opcodes.add(opcode)

    a = [[1, -2, 3], [4, 5, -6]]
    b = [[7, -8], [9, 10], [-11, 12]]
    observed_gemm = await runtime_gemm_s8(dut, a, b)
    assert observed_gemm == golden_gemm_s8(a, b)
    covered_opcodes.add(E1NpuRuntime.OP_GEMM_S8)

    perf_cycles = await runtime_read32(dut, E1NpuRuntime.PERF_CYCLES)
    perf_macs = await runtime_read32(dut, E1NpuRuntime.PERF_MACS)
    perf_errors = await runtime_read32(dut, E1NpuRuntime.PERF_ERRORS)
    assert perf_cycles == 12
    assert perf_macs == 12
    assert perf_errors == 0

    coverage = {
        "schema": "eliza.npu_cocotb_coverage.v1",
        "source": "verify/cocotb/test_e1_npu.py",
        "runtime_contract": "compiler/runtime/e1_npu_runtime.py",
        "covered_opcodes": sorted(covered_opcodes),
        "covered_opcode_names": [case[0] for case in scalar_cases] + ["gemm_s8"],
        "gemm_shapes": [{"m": 2, "n": 2, "k": 3}],
        "status_bits": ["busy", "done", "error"],
        "descriptor_queue": {
            "registers": [
                "DESC_BASE",
                "DESC_HEAD",
                "DESC_TAIL",
                "DESC_STATUS",
                "CMD_PARAM",
                "DESC_BYTES_READ",
                "DESC_BYTES_WRITTEN",
                "DESC_READ_BEATS",
                "DESC_WRITE_BEATS",
            ],
            "descriptor_fetch_launches_scalar": True,
            "descriptor_streams_gemm_s8": True,
            "descriptor_bytes_read_covered": True,
            "descriptor_read_beats_covered": True,
            "descriptor_write_counters_remain_zero_without_writeback": True,
            "missing_descriptor_response_times_out": True,
            "empty_queue_rejects": True,
            "unaligned_base_rejects": True,
            "pending_depth_bits": "DESC_STATUS[21:19]",
            "pending_depth_semantics": "(DESC_HEAD - DESC_TAIL) modulo 8; 0 is empty, not a full-ring encoding",
            "dma_backed_tensor_execution": False,
            "valid_owner_bit_required": True,
            "writeback_request_fails_closed": True,
        },
        "perf_counters": [
            "unsupported_ops",
            "cycles",
            "macs",
            "ops",
            "errors",
            "desc_read_beats",
            "desc_write_beats",
        ],
        "proof_boundary": {
            "nnapi_acceleration": False,
            "phone_class_tops": False,
            "dma_backed_tensor_execution": False,
        },
        "blocking_note": "Directed runtime ABI coverage only; no model, NNAPI, DMA writeback, queue ownership, or performance claim coverage.",
    }
    out = REPO_ROOT / "build/reports/npu_cocotb_coverage.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf-8")
