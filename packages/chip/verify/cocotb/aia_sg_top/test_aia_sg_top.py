"""Integrated-top reachability KAT for the scatter-gather DMA + RISC-V AIA fabric.

The audit finding ``orphan-sg-dma-aplic-imsic-not-instantiated`` flagged that
``e1_dma_sg`` (descriptor scatter-gather DMA), ``e1_aplic`` (AIA Advanced PLIC),
and ``e1_imsic`` (AIA Incoming MSI Controller) are real, standalone-verified RTL
that is instantiated in NO synthesizable top -- a production interrupt/DMA
fabric absent from the hierarchy while docs imply it is complete.

This suite compiles ``e1_soc_top`` with ``+define+E1_SOC_AIA_SG`` (which wires
all three leaves into the SoC) and drives only the integrated top's external
MMIO debug port + observes its top-level outputs. It proves each module is
reachable AND functional THROUGH the integrated hierarchy:

  * sg_dma_reachable_and_copies: program the SG-DMA over the shared MMIO fabric
    (window 0x1005_0xxx), run a one-descriptor chain whose descriptor + source
    payload live in the SG-DMA's own AXI4 burst DRAM, and verify a byte-exact
    copy, the DONE status writeback to the descriptor, and the chain/IRQ flag
    -- exercising the descriptor fetch, payload INCR-burst copy, and status
    writeback paths of the engine inside the top.

  * aia_wire_to_msi_delivery: program the APLIC over the shared MMIO fabric
    (window 0x1006_0xxx) to route the level timer IRQ (source id 1) to host
    IMSIC file 0 with EIID 1, raise the real timer IRQ via the peripheral timer
    window, and verify the IMSIC raises the host file's external-interrupt line
    (aia_eip_o[0]) -- exercising the full wire->APLIC->MSI->IMSIC->hart path
    inside the top.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# --- SoC MMIO windows (byte address bases). ---
SGDMA_BASE = 0x1005_0000  # e1_dma_sg register window
APLIC_BASE = 0x1006_0000  # e1_aplic config window
PERIPH_BASE = 0x1000_0000  # e1_peripherals (timer)

# --- e1_dma_sg register map (word index -> byte offset). ---
SG_RING_HEAD = 0x00 << 2
SG_CTRL = 0x01 << 2
SG_STATUS = 0x02 << 2
SG_IRQ_EN = 0x03 << 2
SG_DESC_DONE = 0x06 << 2
SG_BYTES_DONE = 0x07 << 2

SG_CTRL_START = 0x1

SG_ST_BUSY = 0x1
SG_ST_DONE = 0x2
SG_ST_ERR = 0x4
SG_ST_IRQ = 0x8
SG_ST_CHAIN_DONE = 0x400

# --- e1_dma_sg descriptor layout (byte offsets in the 32-byte descriptor). ---
D_SRC = 0x00
D_DST = 0x04
D_LEN = 0x08
D_FLAGS = 0x0C
D_NEXT = 0x10
D_STATUS = 0x14
DESC_SIZE = 0x20

F_OWN = 0x1
F_IRQ = 0x2
F_LAST = 0x4

# --- e1_peripherals register map (word index). ---
PERIPH_TIMER_COMPARE = 0x04 << 2

# --- APLIC config window encoding (see e1_soc_top E1_SOC_AIA_SG block).
#   addr[2]        -> domain (0=M, 1=S)
#   addr[4:3]      -> field  (0=sourcecfg, 1=ie, 2=target)
#   addr[5+:SRC_W] -> source id
F_SOURCECFG = 0
F_IE = 1
F_TARGET = 2
DOM_M = 0

SM_LEVEL = 2  # sourcecfg.sm level-high


def aplic_cfg_addr(domain: int, field: int, src: int) -> int:
    """Byte address in the APLIC config window for (domain, field, source)."""
    return APLIC_BASE | (src << 5) | (field << 3) | (domain << 2)


async def reset(dut):
    dut.rst_n.value = 0
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    dut.mmio_addr.value = 0
    dut.mmio_wdata.value = 0
    await Timer(1, units="ns")
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def mmio_write(dut, addr: int, data: int) -> None:
    """Single-beat write over the SoC external MMIO debug port (master 0)."""
    dut.mmio_addr.value = addr
    dut.mmio_wdata.value = data
    dut.mmio_write.value = 1
    dut.mmio_valid.value = 1
    # The non-real-subsys fabric regions complete in one cycle (fab_ready=valid).
    while True:
        await RisingEdge(dut.clk)
        if int(dut.mmio_ready.value):
            break
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    await Timer(1, units="ns")


async def mmio_read(dut, addr: int) -> int:
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    while True:
        await Timer(1, units="ns")
        if int(dut.mmio_ready.value):
            value = int(dut.mmio_rdata.value)
            break
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    await Timer(1, units="ns")
    return value


# ── SG-DMA private AXI4 DRAM white-box access (u_sg_dram.mem, 32-bit beats). ──
def dram_word_set(dut, byte_addr: int, value: int) -> None:
    """Write a 32-bit word into the SG-DMA's private DRAM (32-bit beat array)."""
    assert byte_addr % 4 == 0
    idx = byte_addr // 4
    dut.u_sg_dram.mem[idx].value = value & 0xFFFF_FFFF


def dram_word_get(dut, byte_addr: int) -> int:
    assert byte_addr % 4 == 0
    idx = byte_addr // 4
    return int(dut.u_sg_dram.mem[idx].value) & 0xFFFF_FFFF


def build_descriptor(dut, desc_addr: int, src: int, dst: int, length: int,
                     flags: int, nxt: int) -> None:
    dram_word_set(dut, desc_addr + D_SRC, src)
    dram_word_set(dut, desc_addr + D_DST, dst)
    dram_word_set(dut, desc_addr + D_LEN, length)
    dram_word_set(dut, desc_addr + D_FLAGS, flags)
    dram_word_set(dut, desc_addr + D_NEXT, nxt)
    dram_word_set(dut, desc_addr + D_STATUS, 0)


@cocotb.test()
async def sg_dma_reachable_and_copies(dut):
    """SG-DMA is reachable over the integrated MMIO fabric and copies bytes."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    # Confirm the register window is reachable through the fabric: the SG-DMA
    # RING_HEAD reads back what we write (a dead window returns 0xDEAD_BEEF).
    await mmio_write(dut, SGDMA_BASE + SG_RING_HEAD, 0x0000_0200)
    head = await mmio_read(dut, SGDMA_BASE + SG_RING_HEAD)
    assert head == 0x0000_0200, f"SG-DMA RING_HEAD not reachable: {head:#010x}"

    # Lay out, in the SG-DMA's private DRAM:
    #   src payload @ 0x000 (4 words), dst @ 0x040, descriptor @ 0x200.
    src_addr = 0x000
    dst_addr = 0x040
    desc_addr = 0x200
    payload = [0x11223344, 0x55667788, 0x99AABBCC, 0xDDEEFF00]
    for i, word in enumerate(payload):
        dram_word_set(dut, src_addr + i * 4, word)
        dram_word_set(dut, dst_addr + i * 4, 0)
    build_descriptor(
        dut, desc_addr, src_addr, dst_addr, len(payload) * 4,
        F_OWN | F_IRQ | F_LAST, 0,
    )

    await mmio_write(dut, SGDMA_BASE + SG_IRQ_EN, 0x3)  # done + error IRQ enable
    await mmio_write(dut, SGDMA_BASE + SG_RING_HEAD, desc_addr)
    await mmio_write(dut, SGDMA_BASE + SG_CTRL, SG_CTRL_START)

    # Wait for the chain to retire (BUSY drops, DONE/CHAIN_COMPLETE latch).
    status = 0
    for _ in range(2000):
        await RisingEdge(dut.clk)
        status = await mmio_read(dut, SGDMA_BASE + SG_STATUS)
        if not (status & SG_ST_BUSY) and (status & SG_ST_CHAIN_DONE):
            break
    assert not (status & SG_ST_BUSY), f"SG-DMA still busy: {status:#010x}"
    assert status & SG_ST_DONE, f"SG-DMA DONE not set: {status:#010x}"
    assert status & SG_ST_CHAIN_DONE, f"chain not complete: {status:#010x}"
    assert not (status & SG_ST_ERR), f"SG-DMA error: {status:#010x}"
    assert status & SG_ST_IRQ, f"completion IRQ not latched: {status:#010x}"

    # Top-level SG-DMA IRQ output asserted (reachable irq line out of the top).
    assert int(dut.sg_dma_irq_o.value) == 1, "sg_dma_irq_o not asserted"

    # Byte-exact copy in the engine's private DRAM.
    for i, word in enumerate(payload):
        got = dram_word_get(dut, dst_addr + i * 4)
        assert got == word, (
            f"copy mismatch @word {i}: got {got:#010x} want {word:#010x}"
        )

    # Descriptor status writeback marks DONE (bit0) without ERR (bit1).
    desc_status = dram_word_get(dut, desc_addr + D_STATUS)
    assert desc_status & 0x1, f"desc DONE not written back: {desc_status:#010x}"
    assert not (desc_status & 0x2), f"desc ERR set: {desc_status:#010x}"

    # Counters reflect the move.
    desc_done = await mmio_read(dut, SGDMA_BASE + SG_DESC_DONE)
    bytes_done = await mmio_read(dut, SGDMA_BASE + SG_BYTES_DONE)
    assert desc_done == 1, f"DESC_DONE={desc_done}"
    assert bytes_done == len(payload) * 4, f"BYTES_DONE={bytes_done}"


@cocotb.test()
async def aia_wire_to_msi_delivery(dut):
    """A wired IRQ programmed through the APLIC reaches the IMSIC file line.

    Drives the full RISC-V AIA path inside the integrated top: a real timer
    IRQ (peripheral block, source id 1) -> APLIC sourcecfg/enable/target ->
    MSI write -> IMSIC doorbell -> host file external IRQ (aia_eip_o[0]).
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    src_id = 1  # source id 1 == timer IRQ on the AIA source vector
    eiid = 1
    host_file = 0

    # APLIC config window read returns the live source-line vector; at reset
    # the timer line is low.
    sources = await mmio_read(dut, APLIC_BASE)
    assert (sources & (1 << (src_id - 1))) == 0, "timer line high before arm"

    # Program APLIC: source 1 = level-high, enabled in M domain, target host
    # file 0 with EIID 1, non-secure world. The target write also enables
    # EIID 1 on the host IMSIC file (eie hook in the integration).
    await mmio_write(dut, aplic_cfg_addr(DOM_M, F_SOURCECFG, src_id), SM_LEVEL)
    await mmio_write(dut, aplic_cfg_addr(DOM_M, F_IE, src_id), 0x1)
    target = (host_file & 0x1) | ((eiid & 0x3F) << 16)
    await mmio_write(dut, aplic_cfg_addr(DOM_M, F_TARGET, src_id), target)

    # Host file IRQ must still be low before the source asserts.
    await RisingEdge(dut.clk)
    assert int(dut.aia_eip_o.value) & (1 << host_file) == 0, "EIP set early"

    # Raise the real timer IRQ: program a small compare so timer_count crosses
    # it within a few cycles (irq_timer = compare!=0 && count>=compare).
    await mmio_write(dut, PERIPH_BASE + PERIPH_TIMER_COMPARE, 0x2)

    # The level source fires once -> APLIC emits an MSI -> IMSIC sets EIP ->
    # the host file external IRQ asserts.
    fired = False
    for _ in range(64):
        await RisingEdge(dut.clk)
        if int(dut.aia_eip_o.value) & (1 << host_file):
            fired = True
            break
    assert fired, "host IMSIC file IRQ never asserted from the AIA path"

    # The secure file (bit 1) must NOT have been targeted by a non-secure MSI.
    assert int(dut.aia_eip_o.value) & (1 << 1) == 0, "secure file spuriously set"
