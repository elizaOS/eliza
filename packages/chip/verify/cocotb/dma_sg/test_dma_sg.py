"""Known-answer tests for the descriptor scatter-gather DMA (e1_dma_sg).

The DUT is a full AXI4 master.  This suite stands up a byte-addressed Python
AXI4 slave memory behind randomized ready/valid backpressure, builds
memory-resident descriptor rings, kicks the engine over its MMIO register port,
and asserts:

  * multi-descriptor scatter-gather copies are byte-exact at every destination,
  * an unaligned head/tail transfer copies the exact byte range and touches no
    neighbouring bytes,
  * the completion IRQ asserts and is W1C-clearable,
  * an AXI DECERR region sets the descriptor error status + global error + error
    IRQ, increments the error counter, and halts the chain without corrupting a
    sibling descriptor's destination.

It drives the AXI4 master ports directly (no SoC fabric); SoC-fabric wiring and
the Linux dmaengine driver are tracked as follow-ons.
"""

import random
import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_reg, write_reg  # noqa: E402

# --- MMIO register map (word index) ---
REG_RING_HEAD = 0x00
REG_CTRL = 0x01
REG_STATUS = 0x02
REG_IRQ_EN = 0x03
REG_AXCACHE = 0x04
REG_CUR_DESC = 0x05
REG_DESC_DONE = 0x06
REG_BYTES_DONE = 0x07
REG_ERR_COUNT = 0x08
REG_ERR_CODE = 0x09

CTRL_START = 0x1
CTRL_IRQ_CLR = 0x2

ST_BUSY = 0x1
ST_DONE = 0x2
ST_ERR = 0x4
ST_IRQ = 0x8

# --- descriptor layout (byte offsets) ---
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

RESP_OKAY = 0
RESP_DECERR = 3


async def reset(dut):
    dut.rst_n.value = 0
    dut.valid.value = 0
    dut.write.value = 0
    dut.addr.value = 0
    dut.wdata.value = 0
    for sig in ("m_arready", "m_rvalid", "m_rdata", "m_rlast", "m_rresp",
                "m_awready", "m_wready", "m_bvalid", "m_bresp"):
        getattr(dut, sig).value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


def desc_bytes(src, dst, length, flags, nxt):
    """Serialize an 8-word (32-byte) descriptor as little-endian bytes."""
    words = [src, dst, length, flags, nxt, 0, 0, 0]
    out = bytearray()
    for w in words:
        out += int(w & 0xFFFF_FFFF).to_bytes(4, "little")
    return bytes(out)


def write_desc(mem, addr, src, dst, length, flags, nxt):
    for i, b in enumerate(desc_bytes(src, dst, length, flags, nxt)):
        mem[addr + i] = b


class Axi4Slave:
    """Byte-addressed AXI4 INCR slave with randomized backpressure and a
    configurable DECERR region (4 KiB-aligned)."""

    def __init__(self, dut, rng, decerr_pages=frozenset()):
        self.dut = dut
        self.rng = rng
        self.mem = {}
        self.decerr_pages = set(decerr_pages)

    def _decerr(self, addr):
        return (addr & ~0xFFF) in self.decerr_pages

    def rd_word(self, addr):
        base = addr & ~0x3
        return sum(self.mem.get(base + b, 0) << (8 * b) for b in range(4))

    def wr_word(self, addr, data, strb):
        base = addr & ~0x3
        for b in range(4):
            if strb & (1 << b):
                self.mem[base + b] = (data >> (8 * b)) & 0xFF

    async def run(self):
        dut = self.dut
        rng = self.rng
        rd = None       # (addr, beats_left, resp)
        aw = None       # base addr
        wr_resp = None  # resp pending on B
        while True:
            dut.m_arready.value = rd is None and rng.randrange(3) != 0
            dut.m_awready.value = aw is None and rng.randrange(3) != 0
            dut.m_wready.value = aw is not None and rng.randrange(3) != 0

            await Timer(1, units="ns")
            ar_fire = int(dut.m_arvalid.value) and int(dut.m_arready.value)
            aw_fire = int(dut.m_awvalid.value) and int(dut.m_awready.value)
            w_fire = int(dut.m_wvalid.value) and int(dut.m_wready.value)

            if ar_fire:
                addr = int(dut.m_araddr.value)
                beats = int(dut.m_arlen.value) + 1
                rd = [addr, beats, 0]
            if aw_fire:
                aw = int(dut.m_awaddr.value)
            if w_fire and aw is not None:
                data = int(dut.m_wdata.value)
                strb = int(dut.m_wstrb.value)
                if self._decerr(aw):
                    wr_resp = RESP_DECERR
                else:
                    self.wr_word(aw, data, strb)
                    wr_resp = RESP_OKAY
                aw += 4
                if int(dut.m_wlast.value):
                    aw = None

            await RisingEdge(dut.clk)

            # Retire R/B that handshook this cycle.
            if int(dut.m_rvalid.value) and int(dut.m_rready.value):
                dut.m_rvalid.value = 0
            if int(dut.m_bvalid.value) and int(dut.m_bready.value):
                dut.m_bvalid.value = 0

            # Drive next read beat.
            if rd is not None and not int(dut.m_rvalid.value):
                addr, beats, _ = rd
                resp = RESP_DECERR if self._decerr(addr) else RESP_OKAY
                dut.m_rdata.value = self.rd_word(addr)
                dut.m_rresp.value = resp
                last = beats <= 1
                dut.m_rlast.value = 1 if last else 0
                dut.m_rvalid.value = 1
                if last:
                    rd = None
                else:
                    rd = [addr + 4, beats - 1, resp]

            # Drive write response.
            if wr_resp is not None and not int(dut.m_bvalid.value):
                dut.m_bresp.value = wr_resp
                dut.m_bvalid.value = 1
                wr_resp = None


async def start_chain(dut, head):
    await write_reg(dut, REG_IRQ_EN, 0x3)
    await write_reg(dut, REG_RING_HEAD, head)
    await write_reg(dut, REG_CTRL, CTRL_START)


async def wait_idle(dut, timeout=200000):
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        status = await read_reg(dut, REG_STATUS)
        if not (status & ST_BUSY):
            return status
    raise TimeoutError("DMA chain did not finish")


@cocotb.test()
async def sg_multi_descriptor_copy_is_byte_exact(dut):
    """A 3-descriptor scatter-gather chain copies every byte to the right
    place; only the last descriptor requests an IRQ."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0x5C_A77E_12)
    slv = Axi4Slave(dut, rng)
    await reset(dut)
    cocotb.start_soon(slv.run())

    ring = 0x0000_1000
    # Three source/dest segments scattered across the address space.
    segs = [
        (0x0010_0000, 0x0020_0000, 64),
        (0x0011_0000, 0x0021_0000, 40),
        (0x0012_0000, 0x0022_0000, 100),
    ]
    payload = {}
    for src, _dst, length in segs:
        for off in range(length):
            v = rng.randrange(256)
            slv.mem[src + off] = v
            payload[src + off] = v

    for i, (src, dst, length) in enumerate(segs):
        last = i == len(segs) - 1
        flags = F_OWN | (F_IRQ if last else 0) | (F_LAST if last else 0)
        nxt = 0 if last else ring + (i + 1) * DESC_SIZE
        write_desc(slv.mem, ring + i * DESC_SIZE, src, dst, length, flags, nxt)

    await start_chain(dut, ring)
    status = await wait_idle(dut)

    assert status & ST_DONE, f"chain not DONE: status={status:#x}"
    assert not (status & ST_ERR), f"unexpected error: status={status:#x}"
    assert int(dut.irq.value) == 1, "completion IRQ not asserted"

    total = sum(length for _, _, length in segs)
    assert await read_reg(dut, REG_DESC_DONE) == 3
    assert await read_reg(dut, REG_BYTES_DONE) == total

    for src, dst, length in segs:
        for off in range(length):
            assert slv.mem.get(dst + off, 0) == payload[src + off], (
                f"mismatch at dst {dst + off:#x}")
        # A 32-byte-spaced sibling region must be untouched.
        assert (dst + length) not in slv.mem or slv.mem[dst + length] == 0

    # IRQ is W1C-clearable.
    await write_reg(dut, REG_CTRL, CTRL_IRQ_CLR)
    assert int(dut.irq.value) == 0
    assert not (await read_reg(dut, REG_STATUS) & ST_IRQ)


@cocotb.test()
async def sg_unaligned_head_and_tail_is_exact(dut):
    """src and dst at different sub-word byte offsets, non-word length: every
    payload byte lands and no neighbour byte is disturbed."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0x0FF5E7)
    slv = Axi4Slave(dut, rng)
    await reset(dut)
    cocotb.start_soon(slv.run())

    src = 0x0030_0003   # +3 byte offset
    dst = 0x0040_0001   # +1 byte offset
    length = 70         # spans several beats, unaligned both ends

    # Pre-seed the dst neighbourhood with a sentinel to detect stray writes.
    for off in range(-4, length + 4):
        slv.mem[dst + off] = 0x5A
    payload = []
    for off in range(length):
        v = rng.randrange(256)
        slv.mem[src + off] = v
        payload.append(v)

    ring = 0x0000_2000
    write_desc(slv.mem, ring, src, dst, length, F_OWN | F_IRQ | F_LAST, 0)
    await start_chain(dut, ring)
    status = await wait_idle(dut)

    assert status & ST_DONE and not (status & ST_ERR), f"status={status:#x}"
    assert await read_reg(dut, REG_BYTES_DONE) == length

    for off in range(length):
        assert slv.mem.get(dst + off) == payload[off], f"byte +{off} wrong"
    # Bytes immediately before and after the range keep their sentinel.
    for off in (-4, -3, -2, -1, length, length + 1, length + 2, length + 3):
        assert slv.mem.get(dst + off) == 0x5A, f"neighbour +{off} corrupted"


@cocotb.test()
async def sg_long_transfer_spans_many_bursts(dut):
    """A 4 KiB descriptor forces many MAX_BEATS bursts; every byte must land
    and bytes_done must equal the full length."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0x10_46_71)
    slv = Axi4Slave(dut, rng)
    await reset(dut)
    cocotb.start_soon(slv.run())

    src = 0x0080_0000
    dst = 0x0090_0000
    length = 4096
    payload = []
    for off in range(length):
        v = rng.randrange(256)
        slv.mem[src + off] = v
        payload.append(v)

    ring = 0x0000_5000
    write_desc(slv.mem, ring, src, dst, length, F_OWN | F_IRQ | F_LAST, 0)
    await start_chain(dut, ring)
    status = await wait_idle(dut)

    assert status & ST_DONE and not (status & ST_ERR), f"status={status:#x}"
    assert await read_reg(dut, REG_BYTES_DONE) == length
    for off in range(length):
        assert slv.mem.get(dst + off) == payload[off], f"long byte +{off} wrong"


@cocotb.test()
async def sg_axcache_attribute_drives_bus(dut):
    """The programmed AXCACHE attribute (cacheable vs device) is presented on
    ARCACHE/AWCACHE for the data mover -- the coherency-policy hook."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0xCAC_4E)
    slv = Axi4Slave(dut, rng)
    await reset(dut)
    cocotb.start_soon(slv.run())

    src = 0x00D0_0000
    dst = 0x00E0_0000
    for off in range(32):
        slv.mem[src + off] = (off + 1) & 0xFF

    write_back_rw = 0xF  # CACHE_WRITE_BACK_RW
    await write_reg(dut, REG_AXCACHE, write_back_rw)
    assert (await read_reg(dut, REG_AXCACHE)) == write_back_rw

    ring = 0x0000_6000
    write_desc(slv.mem, ring, src, dst, 32, F_OWN | F_IRQ | F_LAST, 0)
    await write_reg(dut, REG_IRQ_EN, 0x3)
    await write_reg(dut, REG_RING_HEAD, ring)
    await write_reg(dut, REG_CTRL, CTRL_START)

    # Observe the cache attribute on the bus during the run.
    seen_ar = seen_aw = False
    for _ in range(20000):
        await Timer(1, units="ns")
        if int(dut.m_arvalid.value):
            assert int(dut.m_arcache.value) == write_back_rw
            seen_ar = True
        if int(dut.m_awvalid.value):
            assert int(dut.m_awcache.value) == write_back_rw
            seen_aw = True
        await RisingEdge(dut.clk)
        if not (await read_reg(dut, REG_STATUS) & ST_BUSY):
            break
    assert seen_ar and seen_aw, "did not observe ARCACHE/AWCACHE on the bus"
    for off in range(32):
        assert slv.mem.get(dst + off) == ((off + 1) & 0xFF)


@cocotb.test()
async def sg_decerr_sets_error_status_and_irq_without_corrupting_siblings(dut):
    """A DECERR region on descriptor #1's read sets the descriptor + global
    error status, raises the error IRQ, halts the chain, and leaves descriptor
    #0 (already completed) and descriptor #2's destination untouched."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    rng = random.Random(0xDEC_E12)
    bad_page = 0x00B0_0000
    slv = Axi4Slave(dut, rng, decerr_pages={bad_page})
    await reset(dut)
    cocotb.start_soon(slv.run())

    ring = 0x0000_3000
    good_src0 = 0x00A0_0000
    good_dst0 = 0x00C0_0000
    bad_src1 = bad_page + 0x10        # reads here return DECERR
    good_dst1 = 0x00C1_0000
    good_src2 = 0x00A2_0000
    good_dst2 = 0x00C2_0000

    for off in range(32):
        slv.mem[good_src0 + off] = (off ^ 0x33) & 0xFF
        slv.mem[good_src2 + off] = (off ^ 0x77) & 0xFF
    # Sentinel descriptor #2 dst so we can prove the chain halted before it.
    for off in range(32):
        slv.mem[good_dst2 + off] = 0xEE

    write_desc(slv.mem, ring + 0 * DESC_SIZE, good_src0, good_dst0, 32,
               F_OWN, ring + 1 * DESC_SIZE)
    write_desc(slv.mem, ring + 1 * DESC_SIZE, bad_src1, good_dst1, 32,
               F_OWN, ring + 2 * DESC_SIZE)
    write_desc(slv.mem, ring + 2 * DESC_SIZE, good_src2, good_dst2, 32,
               F_OWN | F_IRQ | F_LAST, 0)

    await start_chain(dut, ring)
    status = await wait_idle(dut)

    assert status & ST_ERR, f"error status not set: status={status:#x}"
    assert int(dut.irq.value) == 1, "error IRQ not asserted"
    assert await read_reg(dut, REG_ERR_COUNT) == 1
    err_code = await read_reg(dut, REG_ERR_CODE)
    assert err_code == 1, f"expected read-error code 1, got {err_code}"

    # Descriptor #0 completed before the fault.
    assert await read_reg(dut, REG_DESC_DONE) == 1
    for off in range(32):
        assert slv.mem.get(good_dst0 + off) == ((off ^ 0x33) & 0xFF)

    # Descriptor #1's status word is written back with ERR set, DONE clear.
    d1_status = slv.rd_word(ring + 1 * DESC_SIZE + D_STATUS)
    assert d1_status & 0x2, f"desc#1 ERR not set: {d1_status:#x}"
    assert not (d1_status & 0x1), f"desc#1 wrongly DONE: {d1_status:#x}"
    assert ((d1_status >> 8) & 0x3) == 1, f"desc#1 err_code wrong: {d1_status:#x}"

    # Chain halted: descriptor #2's dst keeps its sentinel.
    for off in range(32):
        assert slv.mem.get(good_dst2 + off) == 0xEE, "sibling desc#2 corrupted"

    await write_reg(dut, REG_CTRL, CTRL_IRQ_CLR)
    assert int(dut.irq.value) == 0
