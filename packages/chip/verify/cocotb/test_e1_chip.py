import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


async def reset(dut):
    dut.RST_N.value = 0
    dut.DBG_VALID.value = 0
    dut.DBG_LAUNCH.value = 0
    dut.DBG_WRITE.value = 0
    dut.DBG_ADDR.value = 0
    dut.DBG_WDATA.value = 0
    dut.TEST_MODE.value = 0
    dut.JTAG_TCK.value = 0
    dut.JTAG_TMS.value = 0
    dut.JTAG_TDI.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.CLK_IN)
    dut.RST_N.value = 1
    for _ in range(4):
        await RisingEdge(dut.CLK_IN)


async def dbg_pulse(dut, addr, data=0, write=False, launch=False):
    dut.DBG_ADDR.value = addr
    dut.DBG_WDATA.value = data
    dut.DBG_WRITE.value = int(write)
    dut.DBG_LAUNCH.value = int(launch)
    dut.DBG_VALID.value = 1
    await RisingEdge(dut.CLK_IN)
    dut.DBG_VALID.value = 0
    dut.DBG_WRITE.value = 0
    dut.DBG_LAUNCH.value = 0
    await RisingEdge(dut.CLK_IN)


async def load_addr(dut, addr):
    for idx in range(8):
        await dbg_pulse(dut, idx, (addr >> (4 * idx)) & 0xF, True)


async def load_wdata(dut, data):
    for idx in range(8):
        await dbg_pulse(dut, 8 + idx, (data >> (4 * idx)) & 0xF, True)


async def write32(dut, addr, data):
    await load_addr(dut, addr)
    await load_wdata(dut, data)
    await dbg_pulse(dut, 0, 0, True, True)


async def read32(dut, addr):
    await load_addr(dut, addr)
    await dbg_pulse(dut, 0, 0, False, True)
    value = 0
    for idx in range(8):
        await dbg_pulse(dut, idx, 0, False)
        value |= int(dut.DBG_RDATA.value) << (4 * idx)
    return value


async def poll_done(dut, addr, cycles=160):
    for _ in range(cycles):
        status = await read32(dut, addr)
        if status & 0x2:
            return status
    raise AssertionError(f"timeout waiting for done at 0x{addr:08x}")


@cocotb.test()
async def chip_debug_bridge_bootrom_gpio_npu(dut):
    cocotb.start_soon(Clock(dut.CLK_IN, 10, units="ns").start())
    await reset(dut)

    assert await read32(dut, 0x0000_0000) == 0x4F50_534F
    assert await read32(dut, 0x0000_0004) == 0x4348_4950

    await write32(dut, 0x1000_0008, 0xA5)
    assert await read32(dut, 0x1000_0008) == 0xA5
    assert int(dut.GPIO.value) == 0xA5

    await write32(dut, 0x1002_0000, 17)
    await write32(dut, 0x1002_0004, 25)
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 42
    assert int(dut.IRQ_NPU.value) == 1

    await write32(dut, 0x1002_000C, 2)
    await write32(dut, 0x1002_0000, 0x04FD_0201)
    await write32(dut, 0x1002_0004, 0x0807_FA05)
    await write32(dut, 0x1002_0014, 10)
    await write32(dut, 0x1002_0010, 4)
    assert await read32(dut, 0x1002_0000) == 0x04FD_0201
    assert await read32(dut, 0x1002_0004) == 0x0807_FA05
    assert await read32(dut, 0x1002_0014) == 10
    assert await read32(dut, 0x1002_0010) == 4
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 14
    assert await read32(dut, 0x1002_0018) == 0

    await write32(dut, 0x1002_000C, 2)
    await write32(dut, 0x1002_0000, 0xFFFF_FFFF)
    await write32(dut, 0x1002_0004, 2)
    await write32(dut, 0x1002_0010, 2)
    assert await read32(dut, 0x1002_0010) == 2
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x2
    assert await read32(dut, 0x1002_0008) == 0xFFFF_FFFE
    assert await read32(dut, 0x1002_0018) == 1

    await write32(dut, 0x1002_000C, 2)
    await write32(dut, 0x1002_0010, 0xF)
    assert await read32(dut, 0x1002_0010) == 0xF
    await write32(dut, 0x1002_000C, 1)
    assert await poll_done(dut, 0x1002_000C) == 0x6
    assert int(dut.IRQ_NPU.value) == 1


@cocotb.test()
async def chip_interrupt_smoke(dut):
    cocotb.start_soon(Clock(dut.CLK_IN, 10, units="ns").start())
    await reset(dut)

    await write32(dut, 0x1000_0010, 8)
    for _ in range(10):
        await RisingEdge(dut.CLK_IN)
    assert int(dut.IRQ_TIMER.value) == 1

    for idx in range(16):
        await write32(dut, 0x8000_0000 + idx * 4, 0xD000_0000 + idx)
    await write32(dut, 0x1001_0000, 0x8000_0000)
    await write32(dut, 0x1001_0004, 0x8000_0080)
    await write32(dut, 0x1001_0008, 64)
    await write32(dut, 0x1001_000C, 1)
    assert await poll_done(dut, 0x1001_000C) == 0x2
    assert int(dut.IRQ_DMA.value) == 1
    assert await read32(dut, 0x1001_0014) == 64
    assert await read32(dut, 0x1001_0018) == 16
    for idx in range(16):
        assert await read32(dut, 0x8000_0080 + idx * 4) == 0xD000_0000 + idx

    await write32(dut, 0x1001_000C, 2)
    await write32(dut, 0x1001_0000, 0x8000_0031)
    await write32(dut, 0x1001_0004, 0x8000_0040)
    await write32(dut, 0x1001_0008, 10)
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

    await write32(dut, 0x1003_0004, (3 << 16) | 4)
    await write32(dut, 0x1003_000C, 1)
    seen = False
    for _ in range((4 + 16 + 96 + 48) * (3 + 10) + 4):
        await RisingEdge(dut.CLK_IN)
        seen = seen or int(dut.IRQ_VSYNC.value) == 1
    assert seen


@cocotb.test()
async def chip_rejects_unimplemented_alias_offsets(dut):
    cocotb.start_soon(Clock(dut.CLK_IN, 10, units="ns").start())
    await reset(dut)

    assert await read32(dut, 0x1002_0100) == 0xDEAD_BEEF
    assert await read32(dut, 0x1002_0001) == 0xDEAD_BEEF

    await write32(dut, 0x1000_0014, 0xFFFF_FFFF)
    before = await read32(dut, 0x1000_000C)
    await write32(dut, 0x1000_0014, 0x0000_0000)
    after = await read32(dut, 0x1000_000C)
    assert after >= before
