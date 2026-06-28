"""Confidential-I/O KAT for the E1 NPU descriptor accelerator.

Targets docs/security/tee-plan/03-secure-io-iommu-npu.md S4 (NPU as confidential
I/O). The DUT is the production ``rtl/npu/e1_npu.sv`` compiled with
``E1_NPU_SECURE_SIDEBAND`` so the source-ID/domain-tag sideband ports are present
(see verify/cocotb/npu/Makefile.secure-io).

Each test drives a real descriptor through the AXI4-Lite master path — descriptor
fetch, tensor stream into the 64-byte scratchpad, GEMM tile, and result writeback
to DRAM — and asserts:

  1. The KAT GEMM matches the numpy-free ``golden_gemm_s8`` reference, the
     completion IRQ fires, and the writeback bytes in backing memory match.
  2. Every outbound NPU access carries the fixed source ID (NPU_SOURCE_ID),
     the monitor-programmed owning domain, and the secure qualifier — the OOB
     tags the IOMMU (ar_devid/ar_pasid) and IOPMP (secure R/W/X) police.
  3. Private-queue ownership: when owned-private and the policy is locked, a
     host doorbell that does not present the owner token is denied with
     DESC_STATUS.OWNER_ERROR and never starts a fetch.
  4. Perf-counter lockdown: while owned-private with the perf lock armed, the
     host reads 0 from PERF_* counters (no inference timing/MAC side channel),
     while functional completion status stays visible.

This is RTL-simulator KAT evidence; it does not claim NNAPI/VTS or phone-class
throughput.
"""

from __future__ import annotations

import sys
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

REPO_ROOT = Path(__file__).resolve().parents[3]
COCOTB_DIR = Path(__file__).resolve().parents[1]
RUNTIME_DIR = REPO_ROOT / "compiler" / "runtime"
for path in (REPO_ROOT, COCOTB_DIR, RUNTIME_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from common import read_reg, reset, write_reg  # noqa: E402
from e1_npu_runtime import E1NpuRuntime, golden_gemm_s8  # noqa: E402

# Register addresses (6-bit word index on the simple register port).
CTRL_REG = 0x03
PERF_UNSUPPORTED_REG = 0x0B
CMD_PARAM_REG = 0x0C
SEC_OWNER_RB_REG = 0x0D
SEC_OWNER_CFG_REG = 0x0D
SEC_LOCK_REG = 0x0E
SEC_STATUS_REG = 0x0F
GEMM_CFG_REG = 0x08
GEMM_BASE_REG = 0x09
GEMM_STRIDE_REG = 0x0A
DESC_BASE_REG = 0x10
DESC_HEAD_REG = 0x11
DESC_TAIL_REG = 0x12
DESC_STATUS_REG = 0x13
PERF_CYCLES_REG = 0x14
PERF_MACS_REG = 0x15
PERF_OPS_REG = 0x16
PERF_ERRORS_REG = 0x17
DESC_BYTES_READ_REG = 0x19
DESC_BYTES_WRITTEN_REG = 0x1A

# RTL constant (rtl/npu/e1_npu.sv localparam NPU_SOURCE_ID).
NPU_SOURCE_ID = 0x000004

# DESC_STATUS codes (compiler/runtime/e1_npu_runtime.py).
DESC_STATUS_DONE = 0x2
DESC_STATUS_ERROR = 0x4
DESC_STATUS_OWNER_ERROR = 0x40

OWNER_DOMAIN = 0x5A5  # 20-bit monitor-programmed owning confidential domain.


async def poll_done(dut, cycles=512):
    for _ in range(cycles):
        status = await read_reg(dut, CTRL_REG)
        if status & (DESC_STATUS_DONE | DESC_STATUS_ERROR):
            return status
        await RisingEdge(dut.clk)
    raise AssertionError("timeout waiting for descriptor completion")


async def axi_read_responder(dut, memory, observed_reads):
    """AXI4-Lite read responder that records the sideband tag on every AR."""
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
            observed_reads.append(
                (
                    int(dut.m_axil_arsource.value),
                    int(dut.m_axil_ardomain.value),
                    int(dut.m_axil_secure.value),
                )
            )
        else:
            dut.m_axil_arready.value = 0


async def axi_write_responder(dut, memory, observed_writes):
    """AXI4-Lite write responder that records the sideband tag on every AW."""
    pending_aw = None
    pending_w = None
    while True:
        await RisingEdge(dut.clk)
        dut.m_axil_awready.value = pending_aw is None
        dut.m_axil_wready.value = pending_w is None
        if int(dut.m_axil_awvalid.value) and int(dut.m_axil_awready.value):
            pending_aw = int(dut.m_axil_awaddr.value)
            observed_writes.append(
                (
                    int(dut.m_axil_awsource.value),
                    int(dut.m_axil_awdomain.value),
                    int(dut.m_axil_secure.value),
                )
            )
        if int(dut.m_axil_wvalid.value) and int(dut.m_axil_wready.value):
            pending_w = int(dut.m_axil_wdata.value)
        if pending_aw is not None and pending_w is not None and not int(dut.m_axil_bvalid.value):
            memory[pending_aw] = pending_w
            dut.m_axil_bvalid.value = 1
            dut.m_axil_bresp.value = 0
            pending_aw = None
            pending_w = None
        elif int(dut.m_axil_bvalid.value) and int(dut.m_axil_bready.value):
            dut.m_axil_bvalid.value = 0
            dut.m_axil_bresp.value = 0


async def assign_npu_to_domain(dut, owner, *, perf_lock):
    """Monitor programming window: set owner + perf-lock policy, then lock it."""
    cfg = (owner & 0xFFFFF) | (1 << 31)  # set-owned
    if perf_lock:
        cfg |= 1 << 30
    await write_reg(dut, SEC_OWNER_CFG_REG, cfg)
    await write_reg(dut, SEC_LOCK_REG, 1)  # W1S sticky lock


def _build_gemm_descriptor_memory(a, b, *, source_base, c_base_dram):
    """Stream-to-scratch + writeback GEMM_S8 descriptor at ring base 0x4000."""
    a_bytes = bytes(v & 0xFF for row in a for v in row)
    b_bytes = bytes(b[r][c] & 0xFF for r in range(len(b)) for c in range(len(b[0])))
    tensor = a_bytes + b_bytes
    word0 = (
        E1NpuRuntime.DESC_FLAG_VALID_OWNER
        | E1NpuRuntime.DESC_FLAG_WRITEBACK_REQUEST
        | E1NpuRuntime.OP_GEMM_S8
        | E1NpuRuntime.DESC_FLAG_STREAM_TO_SCRATCH
        | (0 << 16)
        | (len(tensor) << 24)
    )
    memory = {
        source_base + i * 4: int.from_bytes(tensor[i * 4 : i * 4 + 4], "little")
        for i in range((len(tensor) + 3) // 4)
    }
    memory.update(
        {
            0x4000: word0,
            0x4004: source_base,
            0x4008: c_base_dram,
            0x400C: 0,
        }
    )
    return memory


@cocotb.test()
async def npu_confidential_gemm_kat_tags_and_completion(dut):
    """KAT: owned-private GEMM_S8 descriptor; assert result, IRQ, and AXI tags."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    a = [[2, -3, 4], [-5, 6, 7]]
    b = [[1, 2], [-3, 4], [5, -6]]
    source_base = 0x5000
    c_base_dram = 0x6000
    memory = _build_gemm_descriptor_memory(a, b, source_base=source_base, c_base_dram=c_base_dram)

    observed_reads: list[tuple[int, int, int]] = []
    observed_writes: list[tuple[int, int, int]] = []
    reader = cocotb.start_soon(axi_read_responder(dut, memory, observed_reads))
    writer = cocotb.start_soon(axi_write_responder(dut, memory, observed_writes))

    # Monitor assigns the NPU to OWNER_DOMAIN with the perf lock armed, then
    # locks the policy.
    await assign_npu_to_domain(dut, OWNER_DOMAIN, perf_lock=True)
    sec_status = await read_reg(dut, SEC_STATUS_REG)
    assert (sec_status >> 8) == NPU_SOURCE_ID, f"SEC_STATUS source id {sec_status:#x}"
    assert sec_status & 0x1, "SEC_STATUS.owned not set"
    assert sec_status & 0x2, "SEC_STATUS.perf_lock not set"
    assert sec_status & 0x4, "SEC_STATUS.perf_hidden not set (owned + locked)"

    # Configure the GEMM tile and arm the ring. Writing PERF_ERRORS (0x17)
    # with bit0 set clears all perf counters (writes are not lockdown-gated).
    await write_reg(dut, PERF_ERRORS_REG, 1)
    await write_reg(dut, GEMM_CFG_REG, 2 | (2 << 8) | (3 << 16))
    await write_reg(dut, GEMM_BASE_REG, 0 | (6 << 8) | (12 << 16))
    await write_reg(dut, GEMM_STRIDE_REG, 3 | (2 << 8) | (8 << 16))
    await write_reg(dut, DESC_BASE_REG, 0x4000)
    await write_reg(dut, DESC_HEAD_REG, 1)
    await write_reg(dut, DESC_TAIL_REG, 0)

    # Owner doorbell: CMD_PARAM[0]=submit, CMD_PARAM[31:12]=owner token.
    await write_reg(dut, CMD_PARAM_REG, 1 | (OWNER_DOMAIN << 12))

    saw_irq = False
    await write_reg(dut, CTRL_REG, 1)
    for _ in range(512):
        if int(dut.irq.value):
            saw_irq = True
        status = await read_reg(dut, CTRL_REG)
        if status & (DESC_STATUS_DONE | DESC_STATUS_ERROR):
            break
        await RisingEdge(dut.clk)
    else:
        raise AssertionError("descriptor did not complete")
    if int(dut.irq.value):
        saw_irq = True

    desc_status = await read_reg(dut, DESC_STATUS_REG)
    assert desc_status & DESC_STATUS_DONE, f"desc_status={desc_status:#x}"
    assert not (desc_status & DESC_STATUS_ERROR), f"desc_status error {desc_status:#x}"
    assert saw_irq, "completion IRQ never asserted"

    # Result tensor in backing DRAM matches the reference.
    expected = golden_gemm_s8(a, b)
    observed = [
        [
            int.from_bytes(
                memory[c_base_dram + (row * 2 + col) * 4].to_bytes(4, "little"),
                "little",
                signed=True,
            )
            for col in range(2)
        ]
        for row in range(2)
    ]
    assert observed == expected, f"RTL GEMM {observed} != golden {expected}"

    # Every outbound access carried the NPU source ID, the owning domain, and
    # the secure qualifier — the OOB tags the IOMMU/IOPMP police.
    assert observed_reads, "no AXI reads observed"
    assert observed_writes, "no AXI writes observed"
    for src, dom, sec in observed_reads:
        assert src == NPU_SOURCE_ID, f"read source id {src:#x}"
        assert dom == OWNER_DOMAIN, f"read domain {dom:#x}"
        assert sec == 1, "read not marked secure while owned-private"
    for src, dom, sec in observed_writes:
        assert src == NPU_SOURCE_ID, f"write source id {src:#x}"
        assert dom == OWNER_DOMAIN, f"write domain {dom:#x}"
        assert sec == 1, "write not marked secure while owned-private"

    # Perf-counter lockdown: host reads 0 from PERF_* while owned + locked,
    # even though the GEMM definitely consumed cycles/macs (proven by the
    # correct result above).
    for reg in (
        PERF_CYCLES_REG,
        PERF_MACS_REG,
        PERF_OPS_REG,
        PERF_ERRORS_REG,
        PERF_UNSUPPORTED_REG,
        DESC_BYTES_READ_REG,
        DESC_BYTES_WRITTEN_REG,
    ):
        assert await read_reg(dut, reg) == 0, f"PERF reg {reg:#x} leaked while perf-locked"

    reader.kill()
    writer.kill()


@cocotb.test()
async def npu_private_queue_rejects_host_doorbell_without_owner_token(dut):
    """Owned-private + locked: a doorbell missing the owner token is denied."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    memory: dict[int, int] = {}
    observed_reads: list[tuple[int, int, int]] = []
    reader = cocotb.start_soon(axi_read_responder(dut, memory, observed_reads))

    await assign_npu_to_domain(dut, OWNER_DOMAIN, perf_lock=True)

    # Arm a (well-formed) ring so the only failing condition is ownership.
    await write_reg(dut, DESC_BASE_REG, 0x4000)
    await write_reg(dut, DESC_HEAD_REG, 1)
    await write_reg(dut, DESC_TAIL_REG, 0)

    # Host doorbell WITHOUT the owner token (domain field = 0).
    await write_reg(dut, CMD_PARAM_REG, 1)
    await write_reg(dut, CTRL_REG, 1)
    for _ in range(8):
        await RisingEdge(dut.clk)

    desc_status = await read_reg(dut, DESC_STATUS_REG)
    assert desc_status & DESC_STATUS_OWNER_ERROR, f"expected OWNER_ERROR, got {desc_status:#x}"
    # The denied doorbell must never have started a descriptor fetch.
    assert not observed_reads, "denied doorbell still issued an AXI fetch"
    # DESC_TAIL must not have advanced.
    assert await read_reg(dut, DESC_TAIL_REG) == 0, "tail advanced on denied doorbell"

    reader.kill()


@cocotb.test()
async def npu_lock_is_sticky_and_freezes_ownership_policy(dut):
    """After lock, a host write to SEC_OWNER_CFG cannot change owner/perf-lock."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    await assign_npu_to_domain(dut, OWNER_DOMAIN, perf_lock=True)
    before = await read_reg(dut, SEC_OWNER_RB_REG)

    # Host attempts to steal ownership / clear the perf lock after the lock.
    await write_reg(dut, SEC_OWNER_CFG_REG, 0x000ABCDE)  # different domain, owned, no perf-lock
    after = await read_reg(dut, SEC_OWNER_RB_REG)
    assert after == before, f"locked owner policy mutated {before:#x} -> {after:#x}"
    assert (after & 0xFFFFF) == OWNER_DOMAIN, "owner domain changed after lock"
    assert after & (1 << 30), "perf lock cleared after lock"

    # Only reset revokes: after reset the NPU is unowned and unlocked again.
    await reset(dut)
    sec_status = await read_reg(dut, SEC_STATUS_REG)
    assert not (sec_status & 0x1), "NPU still owned after reset"
    assert not (sec_status & 0x10), "lock still set after reset"


@cocotb.test()
async def npu_unowned_perf_counters_are_visible(dut):
    """Without ownership the perf lockdown is inert: counters read normally."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    a = [[2, -3, 4], [-5, 6, 7]]
    b = [[1, 2], [-3, 4], [5, -6]]
    memory = _build_gemm_descriptor_memory(a, b, source_base=0x5000, c_base_dram=0x6000)
    observed_reads: list[tuple[int, int, int]] = []
    observed_writes: list[tuple[int, int, int]] = []
    reader = cocotb.start_soon(axi_read_responder(dut, memory, observed_reads))
    writer = cocotb.start_soon(axi_write_responder(dut, memory, observed_writes))

    # No assign_npu_to_domain: NPU stays unowned.
    sec_status = await read_reg(dut, SEC_STATUS_REG)
    assert not (sec_status & 0x4), "perf_hidden set while unowned"

    await write_reg(dut, GEMM_CFG_REG, 2 | (2 << 8) | (3 << 16))
    await write_reg(dut, GEMM_BASE_REG, 0 | (6 << 8) | (12 << 16))
    await write_reg(dut, GEMM_STRIDE_REG, 3 | (2 << 8) | (8 << 16))
    await write_reg(dut, DESC_BASE_REG, 0x4000)
    await write_reg(dut, DESC_HEAD_REG, 1)
    await write_reg(dut, DESC_TAIL_REG, 0)
    await write_reg(dut, CMD_PARAM_REG, 1)  # no owner token needed while unowned
    await write_reg(dut, CTRL_REG, 1)

    await poll_done(dut, cycles=512)
    desc_status = await read_reg(dut, DESC_STATUS_REG)
    assert desc_status & DESC_STATUS_DONE, f"desc_status={desc_status:#x}"

    # Unowned: tags carry source ID but domain 0 and not secure.
    for src, dom, sec in observed_reads:
        assert src == NPU_SOURCE_ID
        assert dom == 0
        assert sec == 0

    # Perf counters are visible (non-zero macs/cycles for a real GEMM).
    assert await read_reg(dut, PERF_CYCLES_REG) > 0, "perf cycles hidden while unowned"

    reader.kill()
    writer.kill()
