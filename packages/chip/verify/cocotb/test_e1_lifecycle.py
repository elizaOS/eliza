import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

BOOT_ROM_WORDS = {
    0x0000_0000: 0x4F50_534F,
    0x0000_0004: 0x4348_4950,
    0x0000_0008: 0x0000_0001,
    0x0000_000C: 0x0000_1000,
}


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
    dut.mmio_addr.value = addr
    dut.mmio_wdata.value = data
    dut.mmio_write.value = 1
    dut.mmio_valid.value = 1
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    await RisingEdge(dut.clk)


async def read32(dut, addr):
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.mmio_rdata.value)
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    await RisingEdge(dut.clk)
    return value


@cocotb.test()
async def bootrom_contract_words_are_mmio_read_only(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    for addr, expected in BOOT_ROM_WORDS.items():
        assert await read32(dut, addr) == expected

    for addr in BOOT_ROM_WORDS:
        await write32(dut, addr, 0xFFFF_FFFF)
        await write32(dut, addr, 0x0000_0000)

    for addr, expected in BOOT_ROM_WORDS.items():
        assert await read32(dut, addr) == expected


@cocotb.test()
async def absent_lifecycle_security_window_fails_unmapped(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    candidate_security_bases = (
        0x1004_0000,
        0x1005_0000,
        0x2000_0000,
    )
    for base in candidate_security_bases:
        assert await read32(dut, base) == 0xDEAD_BEEF
        await write32(dut, base, 0x1)
        assert await read32(dut, base) == 0xDEAD_BEEF
