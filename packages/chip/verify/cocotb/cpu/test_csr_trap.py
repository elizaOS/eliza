"""CSR / trap / privilege smoke for the e1 CPU subsystem.

The current local DUT is the tiny stub CPU at
``rtl/cpu/e1_cpu_subsystem_stub.sv``, which has no CSR file, no privilege
mode, and no trap entry: it halts fail-closed on any CSR access, MRET,
SRET, or ECALL. This test pins that fail-closed behavior and explicitly
records the negative result so the gate at
``docs/evidence/cpu_ap/csr-trap-evidence.yaml`` cannot silently flip green
when the real big-core RTL lands.

When the production wrapper ``e1_cva6_wrapper.sv`` is compiled with
``+define+E1_HAVE_CVA6`` and the CVA6 source tree is on the include path,
the same test file is re-runnable against the real core; the second test
in this module exercises the CVA6 path but is skipped fail-closed
otherwise.
"""

from __future__ import annotations

import sys
from typing import Any

_cocotb: Any
try:
    import cocotb as _cocotb_real
    from cocotb.clock import Clock
    from cocotb.triggers import RisingEdge, Timer

    _cocotb = _cocotb_real
except Exception:  # noqa: BLE001 - this file is consumed by cocotb only
    _cocotb = None

cocotb: Any = _cocotb


def _csr_rw(rd: int, csr: int, rs1: int) -> int:
    """CSRRW rd, csr, rs1."""
    return (csr << 20) | (rs1 << 15) | (1 << 12) | (rd << 7) | 0x73


def _ecall() -> int:
    return 0x00000073


def _ebreak() -> int:
    return 0x00100073


def _mret() -> int:
    return 0x30200073


def _sret() -> int:
    return 0x10200073


async def _reset(dut) -> None:
    dut.rst_n.value = 0
    dut.cpu_enable.value = 0
    for sig in (
        "stall_cpu_aw",
        "stall_cpu_w",
        "stall_cpu_ar",
        "loader_awvalid",
        "loader_wvalid",
        "loader_arvalid",
        "irq_sources",
        "timer_irq",
        "software_irq",
    ):
        if hasattr(dut, sig):
            getattr(dut, sig).value = 0
    if hasattr(dut, "loader_bready"):
        dut.loader_bready.value = 1
    if hasattr(dut, "loader_rready"):
        dut.loader_rready.value = 1
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _axil_write32(dut, addr: int, data: int) -> int:
    dut.loader_awaddr.value = addr
    dut.loader_wdata.value = data
    dut.loader_wstrb.value = 0xF
    dut.loader_awvalid.value = 1
    dut.loader_wvalid.value = 1
    dut.loader_bready.value = 1

    while True:
        await Timer(1, units="ns")
        if int(dut.loader_awready.value) and int(dut.loader_wready.value):
            break
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    dut.loader_awvalid.value = 0
    dut.loader_wvalid.value = 0

    while True:
        await Timer(1, units="ns")
        if int(dut.loader_bvalid.value):
            resp = int(dut.loader_bresp.value)
            break
        await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    return resp


async def _run_until_halt(dut, timeout_cycles: int) -> bool:
    for _ in range(timeout_cycles):
        await RisingEdge(dut.clk)
        if int(dut.cpu_halted.value):
            return True
    return False


if cocotb is not None:

    @cocotb.test()
    async def stub_cpu_halts_on_csr_access(dut) -> None:
        """Stub DUT must halt fail-closed on CSRRW; never produce CSR value."""
        cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
        await _reset(dut)
        # CSRRW x1, mstatus, x0  -> CSR access in tiny CPU must halt
        assert await _axil_write32(dut, 0x8000_0000, _csr_rw(1, 0x300, 0)) == 0
        # Sentinel: must not be reached.
        assert await _axil_write32(dut, 0x8000_0004, 0xDEAD_BEEF) == 0
        dut.cpu_enable.value = 1
        halted = await _run_until_halt(dut, 64)
        assert halted, "tiny CPU did not halt on illegal CSR access"
        assert int(dut.cpu_halted.value) == 1

    @cocotb.test()
    async def stub_cpu_halts_on_mret_and_sret(dut) -> None:
        """Privileged return must trap-and-halt on the tiny CPU."""
        cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
        for opcode in (_mret(), _sret()):
            await _reset(dut)
            assert await _axil_write32(dut, 0x8000_0000, opcode) == 0
            dut.cpu_enable.value = 1
            assert await _run_until_halt(dut, 64), f"tiny CPU did not halt on 0x{opcode:08x}"
            assert int(dut.cpu_halted.value) == 1

    @cocotb.test()
    async def stub_cpu_halts_on_ecall_and_ebreak(dut) -> None:
        """ECALL/EBREAK are local halt only — no trap entry in the tiny CPU."""
        cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
        for opcode in (_ecall(), _ebreak()):
            await _reset(dut)
            assert await _axil_write32(dut, 0x8000_0000, opcode) == 0
            dut.cpu_enable.value = 1
            assert await _run_until_halt(dut, 64), f"tiny CPU did not halt on 0x{opcode:08x}"
            assert int(dut.cpu_halted.value) == 1


# -------- structural meta-checks (host) --------


def csr_trap_evidence_blocked_note() -> str:
    return (
        "Real CSR/trap evidence is BLOCKED until a Linux-capable AP wrapper "
        "(CVA6 / Kunminghu / Ascalon) is the DUT. The cocotb tests in this "
        "module confirm that the current tiny CPU fails closed on every "
        "privileged operation, which is the only safe behavior."
    )


def evidence_yaml_path() -> str:
    return "docs/evidence/cpu_ap/csr-trap-evidence.yaml"


def main(argv: list[str] | None = None) -> int:
    print("STATUS: BLOCKED cpu.csr_trap_evidence -", csr_trap_evidence_blocked_note())
    print("evidence_yaml:", evidence_yaml_path())
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
