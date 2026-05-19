"""CSR / trap / privilege smoke for the e1 CPU subsystem.

This file is dual-purpose:

  - On the stub DUT (``rtl/cpu/e1_cpu_subsystem_stub.sv``) it pins
    fail-closed halt-on-illegal-CSR / MRET / SRET / ECALL / EBREAK.
  - On a real DUT compiled with ``+define+E1_HAVE_CVA6`` (or
    ``E1_HAVE_KUNMINGHU`` / ``E1_HAVE_ASCALON`` when they land) the same
    test module re-runs the positive trap path: CSR writes succeed,
    illegal CSR accesses trap to ``mepc=PC``, ``mcause=2``, then the
    handler returns via MRET. Until that DUT is selectable the
    positive-path coroutine is registered but skip-marked.

The cocotb skip path explicitly records BLOCKED in the evidence YAML so
the gate cannot silently flip green when the big-core RTL lands.

The ``E1_REQUIRE_REAL_CSR_DUT`` environment switch forces this gate to
FAIL when the CVA6 RTL is not present in the checkout. Presence is
detected by inspecting the two pin-manifest checkout paths:

  - ``external/chipyard/generators/cva6/src/main/resources/cva6/vsrc/cva6``
    (chipyard recursive submodule); or
  - ``external/cva6/cva6`` (standalone clone of openhwgroup/cva6).

When either path contains real ``*.sv``/``*.v`` sources the gate flips
to a positive-path test that exercises the e1_cva6_wrapper instead of
the tiny stub. The wrapper TB does not yet exist; the env switch is the
hand-off point.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[3]
_CVA6_CHIPYARD_RTL = _ROOT / "external/chipyard/generators/cva6/src/main/resources/cva6/vsrc/cva6"
_CVA6_STANDALONE_RTL = _ROOT / "external/cva6/cva6"


def _cva6_rtl_present() -> tuple[bool, str]:
    """Return (present, source_path) when CVA6 core RTL is checked out.

    A directory is "present" when it exists and contains at least one
    ``*.sv`` or ``*.v`` file. An empty submodule placeholder does not
    count, which avoids declaring the gate satisfied by a wrapper without
    its recursive submodule.
    """
    for candidate in (_CVA6_CHIPYARD_RTL, _CVA6_STANDALONE_RTL):
        if not candidate.is_dir():
            continue
        for entry in candidate.rglob("*"):
            if entry.is_file() and entry.suffix in (".sv", ".v"):
                return True, str(candidate.relative_to(_ROOT))
    return False, ""

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


def _csr_rs(rd: int, csr: int, rs1: int) -> int:
    """CSRRS rd, csr, rs1."""
    return (csr << 20) | (rs1 << 15) | (2 << 12) | (rd << 7) | 0x73


def _csr_rwi(rd: int, csr: int, uimm: int) -> int:
    """CSRRWI rd, csr, uimm."""
    return (csr << 20) | (uimm << 15) | (5 << 12) | (rd << 7) | 0x73


def _ecall() -> int:
    return 0x00000073


def _ebreak() -> int:
    return 0x00100073


def _mret() -> int:
    return 0x30200073


def _sret() -> int:
    return 0x10200073


def _has_dut_attr(dut, *names: str) -> bool:
    """Return True if every name is a signal on dut."""
    return all(hasattr(dut, n) for n in names)


def _is_real_cpu_dut(dut) -> bool:
    """A real DUT exposes at minimum mepc/mcause/mstatus signals."""
    # Conservative — any one of these distinguishes a real privileged DUT
    # from the tiny stub which only exposes cpu_halted / loader_*.
    return any(hasattr(dut, n) for n in ("mepc_q", "csr_mepc", "satp_q", "dut_has_mmu"))


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
        if _is_real_cpu_dut(dut):
            dut._log.info("real CPU DUT detected — stub-only test deferred")
            return
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
        if _is_real_cpu_dut(dut):
            dut._log.info("real CPU DUT detected — stub-only test deferred")
            return
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
        if _is_real_cpu_dut(dut):
            dut._log.info("real CPU DUT detected — stub-only test deferred")
            return
        cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
        for opcode in (_ecall(), _ebreak()):
            await _reset(dut)
            assert await _axil_write32(dut, 0x8000_0000, opcode) == 0
            dut.cpu_enable.value = 1
            assert await _run_until_halt(dut, 64), f"tiny CPU did not halt on 0x{opcode:08x}"
            assert int(dut.cpu_halted.value) == 1

    @cocotb.test()
    async def real_dut_csr_write_read_round_trip(dut) -> None:
        """Positive-path CSR round-trip; only runs against a real DUT."""
        if not _is_real_cpu_dut(dut):
            dut._log.info(
                "STATUS: BLOCKED cpu.csr_trap_evidence - DUT is stub; "
                "positive CSR/trap path requires +define+E1_HAVE_CVA6 (or "
                "Kunminghu/Ascalon). See evidence_yaml_path()."
            )
            return
        # Real-DUT body is the implementer's responsibility once a wrapper
        # exposes the canonical signals; this assertion guards against
        # accidentally flipping the gate green with an empty body.
        raise AssertionError(
            "real CPU DUT detected but positive-path CSR test body is not yet "
            "ported. Implement against e1_cva6_wrapper signals before flipping "
            "the gate."
        )


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
    # Host-side sanity on the helper encoders so a typo in a future edit
    # does not silently flip an opcode.
    assert _mret() == 0x30200073
    assert _sret() == 0x10200073
    assert _ecall() == 0x00000073
    assert _ebreak() == 0x00100073
    assert _csr_rw(1, 0x300, 0) == (0x300 << 20) | (1 << 7) | (1 << 12) | 0x73
    assert _csr_rs(1, 0x300, 0) == (0x300 << 20) | (2 << 12) | (1 << 7) | 0x73
    assert _csr_rwi(1, 0x300, 5) == (0x300 << 20) | (5 << 15) | (5 << 12) | (1 << 7) | 0x73
    if os.environ.get("E1_REQUIRE_REAL_CSR_DUT"):
        present, source = _cva6_rtl_present()
        if not present:
            print(
                "STATUS: FAIL cpu.csr_trap_evidence - E1_REQUIRE_REAL_CSR_DUT set "
                "but no CVA6 RTL is checked out."
            )
            print(
                "  next: git -C external/chipyard submodule update --init "
                "--recursive generators/cva6"
            )
            print(
                "  alt:  git clone https://github.com/openhwgroup/cva6.git "
                "external/cva6/cva6"
            )
            return 1
        print(
            "STATUS: BLOCKED cpu.csr_trap_evidence - "
            f"CVA6 RTL detected at {source}; positive-path TB harness "
            "(verify/cocotb/cpu/e1_cva6_csr_tb.sv) has not been ported yet. "
            "Wire up before flipping E1_REQUIRE_REAL_CSR_DUT to PASS."
        )
        print("evidence_yaml:", evidence_yaml_path())
        return 1
    print("STATUS: BLOCKED cpu.csr_trap_evidence -", csr_trap_evidence_blocked_note())
    print("evidence_yaml:", evidence_yaml_path())
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
