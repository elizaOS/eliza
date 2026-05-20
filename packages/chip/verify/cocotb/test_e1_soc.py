import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coverage_helpers import CoverPointSet  # noqa: E402

SOC_MMIO_REGIONS = (
    "bootrom",
    "gpio",
    "timer",
    "clint",
    "dma",
    "npu",
    "display",
    "unmapped",
)
SOC_IRQ_VECTORS = ("timer", "dma", "npu", "vsync")
_SOC_COVER = CoverPointSet("soc")
_SOC_COVER.declare("mmio_region", "addr_region", SOC_MMIO_REGIONS)
_SOC_COVER.declare("irq_vector", "soc_irq", SOC_IRQ_VECTORS)


def _classify_mmio(addr: int) -> str:
    if addr < 0x1000_0000:
        if 0x0200_0000 <= addr < 0x0201_0000:
            return "clint"
        return "bootrom"
    if 0x1000_0000 <= addr < 0x1001_0000:
        if addr & 0xFFFF in {0x0010}:
            return "timer"
        return "gpio"
    if 0x1001_0000 <= addr < 0x1002_0000:
        return "dma"
    if 0x1002_0000 <= addr < 0x1003_0000:
        return "npu"
    if 0x1003_0000 <= addr < 0x1004_0000:
        return "display"
    return "unmapped"


async def reset(dut):
    dut.rst_n.value = 0
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    dut.mmio_addr.value = 0
    dut.mmio_wdata.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def write32(dut, addr, data):
    _SOC_COVER.sample("mmio_region", "addr_region", _classify_mmio(addr))
    dut.mmio_addr.value = addr
    dut.mmio_wdata.value = data
    dut.mmio_write.value = 1
    dut.mmio_valid.value = 1
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    await RisingEdge(dut.clk)


async def read32(dut, addr):
    _SOC_COVER.sample("mmio_region", "addr_region", _classify_mmio(addr))
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.mmio_rdata.value)
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    await RisingEdge(dut.clk)
    return value


async def poll_done(dut, addr, cycles=128):
    for _ in range(cycles):
        status = await read32(dut, addr)
        if status & 0x2:
            return status
    raise AssertionError(f"timeout waiting for done at 0x{addr:08x}")


def s32(value):
    return value - 0x1_0000_0000 if value & 0x8000_0000 else value


def golden_gemm_s8(a, b):
    return [
        [sum(a_row[k] * b[k][j] for k in range(len(b))) for j in range(len(b[0]))] for a_row in a
    ]


@cocotb.test()
async def bootrom_and_gpio_contract(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert await read32(dut, 0x0000_0000) == 0x4F50_534F
    assert await read32(dut, 0x0000_0004) == 0x4348_4950

    await write32(dut, 0x1000_0008, 0xA5)
    assert await read32(dut, 0x1000_0008) == 0xA5
    assert int(dut.gpio_out.value) == 0xA5


@cocotb.test()
async def timer_dma_npu_display_interrupts(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await write32(dut, 0x1000_0010, 8)
    for _ in range(10):
        await RisingEdge(dut.clk)
    assert int(dut.irq_timer.value) == 1
    _SOC_COVER.sample("irq_vector", "soc_irq", "timer")

    for idx in range(16):
        await write32(dut, 0x8000_0000 + idx * 4, 0xC000_0000 + idx)
    await write32(dut, 0x1001_0000, 0x8000_0000)
    await write32(dut, 0x1001_0004, 0x8000_0080)
    await write32(dut, 0x1001_0008, 64)
    await write32(dut, 0x1001_000C, 1)
    status = await poll_done(dut, 0x1001_000C)
    assert status == 0x2
    assert int(dut.irq_dma.value) == 1
    _SOC_COVER.sample("irq_vector", "soc_irq", "dma")
    assert await read32(dut, 0x1001_0014) == 64
    assert await read32(dut, 0x1001_0018) == 16
    assert await read32(dut, 0x1001_0024) == 0x8000_003C
    assert await read32(dut, 0x1001_0028) == 0x8000_00BC
    for idx in range(16):
        assert await read32(dut, 0x8000_0080 + idx * 4) == 0xC000_0000 + idx
    dma_trace = await read32(dut, 0x1001_002C)
    assert ((dma_trace >> 7) & 0xF) == 0xF
    assert (dma_trace & 0x7) == 0x0

    await write32(dut, 0x1002_0000, 17)
    await write32(dut, 0x1002_0004, 25)
    await write32(dut, 0x1002_0010, 0)
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 42
    assert int(dut.irq_npu.value) == 1
    _SOC_COVER.sample("irq_vector", "soc_irq", "npu")

    await write32(dut, 0x1002_000C, 2)
    await write32(dut, 0x1002_0000, 0x04FD_0201)
    await write32(dut, 0x1002_0004, 0x0807_FA05)
    await write32(dut, 0x1002_0014, 10)
    await write32(dut, 0x1002_0010, 4)
    assert await read32(dut, 0x1002_0010) == 4
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 14
    assert await read32(dut, 0x1002_0018) == 0

    await write32(dut, 0x1002_000C, 2)
    await write32(dut, 0x1002_0000, 0xFFFF_FFFF)
    await write32(dut, 0x1002_0004, 2)
    await write32(dut, 0x1002_0010, 2)
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 0xFFFF_FFFE
    assert await read32(dut, 0x1002_0018) == 1

    await write32(dut, 0x1002_000C, 2)
    await write32(dut, 0x1002_0010, 0xF)
    assert await read32(dut, 0x1002_0010) == 0xF
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x6
    assert int(dut.irq_npu.value) == 1

    await write32(dut, 0x1003_0000, 0x8000_0000)
    await write32(dut, 0x1003_0004, (480 << 16) | 640)
    await write32(dut, 0x1003_000C, 1)
    assert await read32(dut, 0x1003_0000) == 0x8000_0000


@cocotb.test()
async def npu_scratchpad_gemm_matches_golden_model(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    a = [
        [1, -2, 3],
        [4, 5, -6],
    ]
    b = [
        [7, -8],
        [9, 10],
        [-11, 12],
    ]
    golden = golden_gemm_s8(a, b)

    a_flat = [value for row in a for value in row]
    b_flat = [b[row][col] for row in range(3) for col in range(2)]
    a_base = 0
    b_base = 6
    c_base = 12

    scratch = bytearray(64)
    scratch[a_base : a_base + len(a_flat)] = bytes(value & 0xFF for value in a_flat)
    scratch[b_base : b_base + len(b_flat)] = bytes(value & 0xFF for value in b_flat)
    for word_index in range(16):
        word = int.from_bytes(scratch[word_index * 4 : word_index * 4 + 4], "little")
        await write32(dut, 0x1002_0080 + word_index * 4, word)

    await write32(dut, 0x1002_005C, 1)
    await write32(dut, 0x1002_0020, 2 | (2 << 8) | (3 << 16))
    await write32(dut, 0x1002_0024, a_base | (b_base << 8) | (c_base << 16))
    await write32(dut, 0x1002_0028, 3 | (2 << 8) | (8 << 16))
    await write32(dut, 0x1002_0010, 8)
    await write32(dut, 0x1002_000C, 1)

    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0050) >= 12
    assert await read32(dut, 0x1002_0054) == 12
    assert await read32(dut, 0x1002_005C) == 0

    observed = []
    for row in range(2):
        observed_row = []
        for col in range(2):
            observed_row.append(s32(await read32(dut, 0x1002_0080 + c_base + (row * 2 + col) * 4)))
        observed.append(observed_row)
    assert observed == golden


@cocotb.test()
async def npu_descriptor_streams_tensor_from_dram(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    a = [[1, -2, 3], [4, 5, -6]]
    b = [[7, -8], [9, 10], [-11, 12]]
    tensor = bytes(value & 0xFF for row in a for value in row) + bytes(
        b[row][col] & 0xFF for row in range(3) for col in range(2)
    )
    for index in range(3):
        await write32(
            dut,
            0x8000_0200 + index * 4,
            int.from_bytes(tensor[index * 4 : index * 4 + 4], "little"),
        )

    await write32(dut, 0x8000_0100, 0x8000_0000 | 8 | (1 << 8) | (12 << 24))
    await write32(dut, 0x8000_0104, 0x8000_0200)
    await write32(dut, 0x8000_0108, 0)
    await write32(dut, 0x8000_010C, 0)

    await write32(dut, 0x1002_005C, 1)
    await write32(dut, 0x1002_0020, 2 | (2 << 8) | (3 << 16))
    await write32(dut, 0x1002_0024, 0 | (6 << 8) | (12 << 16))
    await write32(dut, 0x1002_0028, 3 | (2 << 8) | (8 << 16))
    await write32(dut, 0x1002_0040, 0x8000_0100)
    await write32(dut, 0x1002_0044, 1)
    await write32(dut, 0x1002_0048, 0)
    await write32(dut, 0x1002_0030, 1)
    await write32(dut, 0x1002_000C, 1)

    assert await poll_done(dut, 0x1002_000C, cycles=160) == 0x2
    assert await read32(dut, 0x1002_0048) == 1
    assert await read32(dut, 0x1002_004C) == 0x2
    assert await read32(dut, 0x1002_0064) == 28
    assert await read32(dut, 0x1002_0068) == 0
    assert await read32(dut, 0x1002_006C) == 7
    assert await read32(dut, 0x1002_0070) == 0

    observed = []
    for row in range(2):
        observed_row = []
        for col in range(2):
            observed_row.append(s32(await read32(dut, 0x1002_0080 + 12 + (row * 2 + col) * 4)))
        observed.append(observed_row)
    assert observed == golden_gemm_s8(a, b)


@cocotb.test()
async def reset_unmapped_and_clear_edges(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert await read32(dut, 0x1000_0004) == 0
    assert await read32(dut, 0x1000_0008) == 0
    assert await read32(dut, 0x2000_0000) == 0xDEAD_BEEF

    await write32(dut, 0x1002_0000, 0xFFFF_FFFF)
    await write32(dut, 0x1002_0004, 1)
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 0
    assert int(dut.irq_npu.value) == 1
    await write32(dut, 0x1002_000C, 2)
    assert int(dut.irq_npu.value) == 0

    await write32(dut, 0x1001_0008, 0)
    await write32(dut, 0x1001_000C, 1)
    assert await poll_done(dut, 0x1001_000C) == 0x2
    assert int(dut.irq_dma.value) == 1
    await write32(dut, 0x1001_000C, 2)
    assert int(dut.irq_dma.value) == 0

    await write32(dut, 0x1001_0000, 0x8000_0001)
    await write32(dut, 0x1001_0004, 0x8000_0080)
    await write32(dut, 0x1001_0008, 16)
    await write32(dut, 0x1001_000C, 1)
    assert await poll_done(dut, 0x1001_000C) == 0x6
    assert await read32(dut, 0x1001_0014) == 0
    assert await read32(dut, 0x1001_0018) == 0

    await write32(dut, 0x1001_000C, 2)
    await write32(dut, 0x8000_0030, 0x1122_3344)
    await write32(dut, 0x8000_0034, 0x5566_7788)
    await write32(dut, 0x8000_0038, 0x99AA_BBCC)
    await write32(dut, 0x8000_0048, 0)
    await write32(dut, 0x1001_0000, 0x8000_0030)
    await write32(dut, 0x1001_0004, 0x8000_0040)
    await write32(dut, 0x1001_0008, 10)
    await write32(dut, 0x1001_000C, 1)
    assert await poll_done(dut, 0x1001_000C) == 0x2
    assert await read32(dut, 0x1001_0014) == 10
    assert await read32(dut, 0x1001_0018) == 3
    assert await read32(dut, 0x1001_0024) == 0x8000_0038
    assert await read32(dut, 0x1001_0028) == 0x8000_0048
    assert await read32(dut, 0x8000_0040) == 0x1122_3344
    assert await read32(dut, 0x8000_0044) == 0x5566_7788
    assert await read32(dut, 0x8000_0048) == 0x0000_BBCC
    dma_trace = await read32(dut, 0x1001_002C)
    assert ((dma_trace >> 7) & 0xF) == 0x3
    assert (dma_trace & 0x7) == 0x0


@cocotb.test()
async def clint_msip_mtimecmp_and_address_decode(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    assert int(dut.msip_o.value) == 0
    assert int(dut.mtip_o.value) == 0
    assert await read32(dut, 0x0200_0000) == 0

    await write32(dut, 0x0200_0000, 1)
    assert await read32(dut, 0x0200_0000) == 1
    assert int(dut.msip_o.value) == 1

    await write32(dut, 0x0200_0000, 0)
    assert await read32(dut, 0x0200_0000) == 0
    assert int(dut.msip_o.value) == 0

    await write32(dut, 0x0200_BFF8, 0)
    await write32(dut, 0x0200_BFFC, 0)
    await write32(dut, 0x0200_4000, 48)
    await write32(dut, 0x0200_4004, 0)
    assert await read32(dut, 0x0200_4000) == 48
    assert await read32(dut, 0x0200_4004) == 0

    saw_mtip = False
    for _ in range(80):
        await RisingEdge(dut.clk)
        saw_mtip = saw_mtip or int(dut.mtip_o.value) == 1
    assert saw_mtip

    await write32(dut, 0x0200_C000, 0xFFFF_FFFF)
    assert await read32(dut, 0x0200_C000) == 0xDEAD_BEEF
    assert await read32(dut, 0x0201_0000) == 0xDEAD_BEEF


@cocotb.test()
async def display_enable_gates_vsync(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    for _ in range(260):
        await RisingEdge(dut.clk)
    assert int(dut.irq_vsync.value) == 0

    await write32(dut, 0x1003_0004, (3 << 16) | 4)
    await write32(dut, 0x1003_000C, 1)
    seen = False
    for _ in range((4 + 16 + 96 + 48) * (3 + 10) + 4):
        await RisingEdge(dut.clk)
        seen = seen or int(dut.irq_vsync.value) == 1
    assert seen
    _SOC_COVER.sample("irq_vector", "soc_irq", "vsync")


@cocotb.test()
async def display_fetches_top_level_dram_framebuffer(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    for idx, pixel in enumerate((0x00112233, 0x00445566, 0x00778899, 0x00AABBCC)):
        await write32(dut, 0x8000_0000 + idx * 4, pixel)

    await write32(dut, 0x1003_0000, 0x8000_0000)
    await write32(dut, 0x1003_0004, (1 << 16) | 4)
    await write32(dut, 0x1003_0014, 1)
    await write32(dut, 0x1003_0018, 1)
    await write32(dut, 0x1003_000C, 1)

    seen_rgb = set()
    for _ in range(8):
        await Timer(1, units="ns")
        if int(dut.u_display.scan_active.value) and int(dut.u_display.fb_read_ready.value):
            seen_rgb.add(int(dut.u_display.scan_rgb.value))
        await RisingEdge(dut.clk)

    assert seen_rgb & {0x112233, 0x445566, 0x778899, 0xAABBCC}
    assert await read32(dut, 0x1003_0014) == 0
    assert await read32(dut, 0x1003_0018) >= 4
    _SOC_COVER.write_json()
