"""M->S handoff and Linux-kernel bring-up on the REAL CVA6 from REAL DRAM.

Same DUT as `test_opensbi_cva6_boot.py` (`e1_cva6_dram_boot_top`: real CVA6
v5.3.0 fetching from the real `e1_dram_ctrl` through the real fabric, real
CLINT/PLIC, RoT-gated reset), now driven PAST the OpenSBI banner.  The bespoke
read-modify-write atomics adapter has been replaced by the vendored
pulp-platform `axi_riscv_atomics` filter (e1_axi4_riscv_atomics), which resolves
RISC-V atomics + LR/SC with the RVWMO ordering CVA6's wt_axi_adapter assumes —
so the run no longer trips the internal write-ID FIFO assertion that previously
fired shortly after the banner.

The preload image is selected by `+E1_DRAM_PRELOAD_HEX`:

  * The OpenSBI S-mode image (fw/opensbi-cva6-boot) drops to the S-mode payload
    that prints `S-MODE-OK` — the M->S handoff proof.
  * The Linux image (fw/linux-cva6-boot) jumps OpenSBI to a real riscv64 Linux
    `Image` + initramfs whose `/init` prints `ELIZA-USERLAND-OK`.

This test scrapes the ns16550a UART TX stream, records every boot marker it
reaches, writes the transcript, and asserts the milestone named by
`E1_BOOT_REQUIRE` (default `S-MODE-OK`).  It is the honest, marker-driven proof:
whatever furthest marker the bounded run reaches is recorded; the gate decides
PASS/BLOCKED from that.
"""

from __future__ import annotations

import os
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"

# Ordered boot markers, earliest -> furthest.  Each is a substring matched
# against the assembled UART transcript.
MARKERS = [
    ("opensbi_banner", "OpenSBI v"),
    ("smode_handoff", "S-MODE-OK"),
    ("linux_early", "Linux version"),
    ("linux_booting", "Booting Linux"),
    ("linux_mmu", "Switching to"),
    ("linux_freeing_init", "Freeing unused kernel"),
    ("linux_run_init", "Run /init"),
    ("userland", "ELIZA-USERLAND-OK"),
]

TRANSCRIPT = EVIDENCE_DIR / os.environ.get(
    "E1_BOOT_TRANSCRIPT", "linux_boot_cva6.transcript")
REQUIRE = os.environ.get("E1_BOOT_REQUIRE", "S-MODE-OK")
MAX_CYCLES = int(os.environ.get("E1_BOOT_MAX_CYCLES", "20000000"))
# After the required marker (or the furthest goal) appears, drain a window of
# trailing console bytes so the transcript is complete, then $finish.
DRAIN_CYCLES = int(os.environ.get("E1_BOOT_DRAIN_CYCLES", "200000"))
# Idle watchdog: if no new console byte appears for this many cycles AFTER the
# first byte, stop — the boot has wedged (records the furthest marker reached).
IDLE_LIMIT = int(os.environ.get("E1_BOOT_IDLE_LIMIT", "4000000"))

_RUN = os.environ.get("CVA6_VERILATOR_FULL_OK", "1") == "1"


def _furthest(text: str) -> str:
    reached = "none"
    for name, token in MARKERS:
        if token in text:
            reached = name
    return reached


@cocotb.test(skip=not _RUN)
async def test_boot_markers(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    dut.rst_n.value = 0
    dut.boot_verified_i.value = 0
    dut.iopmp_policy_ready_i.value = 0
    dut.lc_scrap_i.value = 0
    dut.plic_sources_i.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)
    dut.boot_verified_i.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.iopmp_policy_ready_i.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)

    assert int(dut.platform_released_o.value) == 1, "RoT did not release CVA6."
    assert int(dut.cva6_rst_n_o.value) == 1, "CVA6 still held in reset."

    chars = bytearray()
    require_seen = False
    cycles = 0
    cycles_since_byte = 0
    saw_first_byte = False

    while cycles < MAX_CYCLES:
        await RisingEdge(dut.clk)
        cycles += 1
        if int(dut.uart_tx_valid_o.value) == 1:
            chars.append(int(dut.uart_tx_byte_o.value) & 0xFF)
            saw_first_byte = True
            cycles_since_byte = 0
            if not require_seen and REQUIRE in chars.decode("latin-1"):
                require_seen = True
                for _ in range(DRAIN_CYCLES):
                    await RisingEdge(dut.clk)
                    cycles += 1
                    if int(dut.uart_tx_valid_o.value) == 1:
                        chars.append(int(dut.uart_tx_byte_o.value) & 0xFF)
                break
        elif saw_first_byte:
            cycles_since_byte += 1
            if cycles_since_byte >= IDLE_LIMIT:
                dut._log.warning(
                    f"console idle for {IDLE_LIMIT} cycles at cycle {cycles}; "
                    "boot wedged — recording furthest marker reached.")
                break

    transcript = chars.decode("latin-1")
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPT.write_text(transcript, encoding="utf-8")

    dram_ar = int(dut.dram_ar_xfers_o.value)
    dram_r = int(dut.dram_r_xfers_o.value)
    uart_aw = int(dut.uart_aw_xfers_o.value)
    furthest = _furthest(transcript)
    dut._log.info(
        f"E1 boot run: {len(chars)} UART bytes, {cycles} cycles, "
        f"DRAM AR={dram_ar} R={dram_r}, UART writes={uart_aw}; "
        f"furthest marker = {furthest}; require={REQUIRE!r} seen={require_seen}")
    dut._log.info("UART transcript:\n" + transcript)

    assert dram_ar >= 1 and dram_r >= 1, (
        f"CVA6 never fetched real DRAM (AR={dram_ar}, R={dram_r}).")
    assert len(chars) > 0, "No UART output — OpenSBI never reached its console."
    assert require_seen, (
        f"Required marker {REQUIRE!r} not observed.  Furthest reached: "
        f"{furthest}.  Transcript:\n{transcript!r}")
    dut._log.info(f"PROVEN: reached required marker {REQUIRE!r}.")
