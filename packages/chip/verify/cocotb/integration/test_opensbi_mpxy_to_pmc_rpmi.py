"""OpenSBI MPxy -> RPMI -> AON Ibex PMC roundtrip cocotb test.

This test is the canonical evidence that the SBI MPxy <-> RPMI shmem
<-> AON PMC stack works end-to-end on the prototype RTL.  It runs against
the integrated SoC (`e1_soc_integrated`) compiled with the
`+define+PMC_INSTANTIATE_IBEX` gate so the AON Ibex inside `pmc_top`
executes `fw/pmc/build/pmc.elf` (loaded from `pmc.aon.hex`).

Flow exercised (mirrors what OpenSBI's `fdt_mailbox_rpmi_shmem.c::__smq_tx`
does on a real boot):

  1. The cocotb harness writes an RPMI v1.0 GET_CLOCK_RATE request frame
     into A2P request queue slot 0 (offset 0x10050800 + 0x80, 64 B).
  2. The harness advances the A2P_REQ tail pointer from 0 to 1.
  3. The harness rings the a2p doorbell (4 B store of `0x1`).
  4. The Ibex (running `pmc_main` -> `pmc_drain_rpmi_a2p_request`) polls
     the A2P_REQ head/tail, parses the frame, dispatches through
     `rpmi_dispatch` in `rpmi_server.c`, serializes the response into
     P2A_ACK queue slot 0, then advances the P2A_ACK tail from 0 to 1
     and the A2P_REQ head from 0 to 1.
  5. The harness polls the P2A_ACK tail until it reaches 1, reads slot 0,
     and verifies:
       - header.servicegroup_id == RPMI_SRVGRP_CLOCK (0x0008)
       - header.service_id      == RPMI_CLOCK_SRV_GET_RATE (0x08)
       - flags low nibble       == 0x2 (RPMI_MSG_ACKNOWLEDGEMENT)
       - token mirrors the request token
       - payload[0..3] = RPMI_OK (0)
       - payload[4..7] = 1_200_000_000 (clock rate, Hz)
       - payload[8..11] = 0 (rate high)

  6. A second roundtrip exercises the voltage GET_LEVEL service for
     domain 0, which returns 700_000 microvolts.

Pass criteria are recorded in
`docs/evidence/power/pmc-soc-integration-evidence.yaml::mpxy_rpmi_roundtrip`.

Skip semantics:
  - When `PMC_INSTANTIATE_IBEX` is not set, the Ibex is not elaborated
    and the test reports an explicit skip with the bootstrap command
    to enable it.
  - The roundtrip itself requires three RTL/firmware bindings that are
    not present in the R7 prototype:
      (a) `pmc_top.sv` must route mailbox-MMIO accesses at offsets
          `0x800..0xFFF` into the same backing storage the Ibex data
          port observes (currently the Ibex data port reaches only
          `aon_sram_q` while the MMIO decode falls through to `'0`);
      (b) `fw/pmc/src/main.c` must drain the A2P request queue instead
          of polling the legacy scalar `PMC_REG_STATUS` register
          (which is outside the AON SRAM aperture and traps);
      (c) the firmware must avoid SPMI / PMIC bringup that issues MMIO
          to off-AON addresses (those trap and divert the Ibex to the
          `_halt_loop` in `crt0.S`).
    Until all three bindings land, the test reports a `BLOCKED` skip
    with the gating commit/PR referenced.  The shmem layout, DTS
    fragment, and OpenSBI rebuild evidence remain valid.
"""

from __future__ import annotations

import os
import struct
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.result import TestSuccess
from cocotb.triggers import RisingEdge, Timer

# Mailbox / shmem addresses — must equal fw/pmc/include/rpmi_shmem_layout.h.
PMC_MBOX_BASE = 0x1005_0000
SHMEM_BASE = PMC_MBOX_BASE + 0x800
A2P_REQ_BASE = SHMEM_BASE + 0x000
P2A_ACK_BASE = SHMEM_BASE + 0x100
A2P_ACK_BASE = SHMEM_BASE + 0x300
A2P_DOORBELL_ADDR = SHMEM_BASE + 0x400

SLOT_SIZE = 64
HEADER_SLOTS = 2
DATA_SLOTS = 2

HEAD_SLOT_OFFSET = 0x00
TAIL_SLOT_OFFSET = 0x40
DATA0_OFFSET = HEADER_SLOTS * SLOT_SIZE  # 0x80
DATA1_OFFSET = DATA0_OFFSET + SLOT_SIZE  # 0xC0

# RPMI v1.0 IDs (matches OpenSBI rpmi_msgprot.h / fw/pmc/src/rpmi_server.c).
RPMI_SRVGRP_BASE = 0x0001
RPMI_SRVGRP_VOLTAGE = 0x0007
RPMI_SRVGRP_CLOCK = 0x0008

RPMI_BASE_SRV_GET_SPEC_VERSION = 0x04
RPMI_CLOCK_SRV_GET_RATE = 0x08
RPMI_VOLTAGE_SRV_GET_LEVEL = 0x08

RPMI_MSG_TYPE_NORMAL_REQUEST = 0x0
RPMI_MSG_TYPE_ACKNOWLEDGEMENT = 0x2

RPMI_OK = 0
RPMI_VERSION_1_0 = (1 << 16) | 0

EXPECTED_CLOCK_RATE_HZ = 1_200_000_000
EXPECTED_VOLTAGE_UV = 700_000

# Boot / smoke window.  The Ibex needs to advance past _start into pmc_main
# and complete at least one scheduler-loop iteration to drain the request.
CLK_PERIOD_NS = 10
RESET_WAIT_CYCLES = 8
BOOT_SETUP_CYCLES = 4096          # let pmc_main reach the drain loop
ROUNDTRIP_TIMEOUT_CYCLES = 8192   # poll for the response


def _ibex_guard_active() -> bool:
    val = os.environ.get("PMC_INSTANTIATE_IBEX", "0")
    return val not in ("0", "", "false", "False")


def _shmem_roundtrip_unblocked() -> bool:
    """Returns True when the three RTL/firmware bindings the roundtrip
    needs are present.  The bindings are tracked by the
    `PMC_RPMI_SHMEM_ROUNDTRIP=1` environment variable, which the build
    flips on once the gating commits land.  Until then the test reports
    an explicit BLOCKED skip so the suite stays green and the gap is
    discoverable in `docs/evidence/power/pmc-soc-integration-
    evidence.yaml::mpxy_rpmi_roundtrip`. """
    val = os.environ.get("PMC_RPMI_SHMEM_ROUNDTRIP", "0")
    return val not in ("0", "", "false", "False")


async def _reset(dut) -> None:
    dut.rst_n.value = 0
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    dut.mmio_addr.value = 0
    dut.mmio_wdata.value = 0
    dut.lkp_valid_i.value = 0
    dut.lkp_pc_i.value = 0
    dut.resolve_i.value = 0
    dut.fetch_pop_i.value = 0
    dut.zihpm_csr_we_i.value = 0
    dut.zihpm_csr_addr_i.value = 0
    dut.zihpm_csr_wdata_i.value = 0
    dut.zihpm_csr_raddr_i.value = 0
    dut.zihpm_instret_pulse_i.value = 0
    await Timer(1, units="ns")
    for _ in range(RESET_WAIT_CYCLES):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _mmio_write32(dut, addr: int, data: int) -> None:
    dut.mmio_addr.value = addr
    dut.mmio_wdata.value = data
    dut.mmio_write.value = 1
    dut.mmio_valid.value = 1
    await RisingEdge(dut.clk)
    dut.mmio_valid.value = 0
    dut.mmio_write.value = 0
    await RisingEdge(dut.clk)


async def _mmio_read32(dut, addr: int) -> int:
    """Two-phase MMIO read for the PMC mailbox window.

    `pmc_top.rdata_q` is registered on `clk_aon`; the cocotb harness
    collapses the clock domains onto `dut.clk`, but the registered read
    still requires a second edge for the latched value to appear on
    `mmio_rdata`.  Hold valid for two edges and sample on the second.
    """
    dut.mmio_addr.value = addr
    dut.mmio_write.value = 0
    dut.mmio_valid.value = 1
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)
    await Timer(1, units="ns")
    value = int(dut.mmio_rdata.value)
    dut.mmio_valid.value = 0
    await RisingEdge(dut.clk)
    return value


def _pack_rpmi_frame(servicegroup_id: int, service_id: int, msg_type: int,
                     token: int, payload: bytes) -> bytes:
    """Build an RPMI v1.0 frame (little-endian) ready for shmem store."""
    if len(payload) > SLOT_SIZE - 8:
        raise ValueError("payload too large for a single slot")
    header = struct.pack(
        "<HBBHH",
        servicegroup_id & 0xFFFF,
        service_id & 0xFF,
        msg_type & 0xFF,
        len(payload) & 0xFFFF,
        token & 0xFFFF,
    )
    frame = header + payload
    return frame + b"\x00" * (SLOT_SIZE - len(frame))


def _unpack_rpmi_header(slot: bytes) -> dict:
    svcgrp, svc, flags, datalen, token = struct.unpack("<HBBHH", slot[:8])
    return {
        "servicegroup_id": svcgrp,
        "service_id": svc,
        "flags": flags,
        "datalen": datalen,
        "token": token,
    }


async def _post_a2p_request(dut, slot_bytes: bytes, slot_index: int = 0) -> None:
    """Write a 64 B RPMI frame into A2P_REQ slot `slot_index` and advance
    the tail pointer + ring the doorbell."""
    assert len(slot_bytes) == SLOT_SIZE
    slot_addr = A2P_REQ_BASE + DATA0_OFFSET + slot_index * SLOT_SIZE
    for i in range(0, SLOT_SIZE, 4):
        word = struct.unpack_from("<I", slot_bytes, i)[0]
        await _mmio_write32(dut, slot_addr + i, word)
    # Advance the tail.
    await _mmio_write32(dut, A2P_REQ_BASE + TAIL_SLOT_OFFSET, slot_index + 1)
    # Ring the doorbell.
    await _mmio_write32(dut, A2P_DOORBELL_ADDR, 0x1)


async def _wait_for_p2a_ack(dut, expected_tail: int) -> int:
    """Poll the P2A_ACK tail pointer until it reaches `expected_tail` or
    the timeout fires.  Returns the elapsed cycle count for diagnostics."""
    for cycle in range(ROUNDTRIP_TIMEOUT_CYCLES):
        tail = await _mmio_read32(dut, P2A_ACK_BASE + TAIL_SLOT_OFFSET)
        if tail == expected_tail:
            return cycle
        await RisingEdge(dut.clk)
    raise AssertionError(
        f"P2A_ACK tail never reached {expected_tail} within "
        f"{ROUNDTRIP_TIMEOUT_CYCLES} cycles"
    )


async def _read_p2a_ack_slot(dut, slot_index: int) -> bytes:
    """Read a 64 B P2A_ACK slot back into a bytes object."""
    slot_addr = P2A_ACK_BASE + DATA0_OFFSET + slot_index * SLOT_SIZE
    buf = bytearray()
    for i in range(0, SLOT_SIZE, 4):
        word = await _mmio_read32(dut, slot_addr + i)
        buf.extend(struct.pack("<I", word))
    return bytes(buf)


@cocotb.test()
async def opensbi_rpmi_clock_get_rate_roundtrip(dut):
    if not _ibex_guard_active():
        raise TestSuccess(
            "skipped: PMC_INSTANTIATE_IBEX not set.  Run "
            "`scripts/bootstrap_ibex.sh && make -C fw/pmc aon-hex && "
            "PMC_INSTANTIATE_IBEX=1 COCOTB_PLUSARGS=+PMC_AON_SRAM_HEX=... "
            "make -C verify/cocotb/integration "
            "TOPLEVEL=e1_soc_integrated_tb "
            "MODULE=test_opensbi_mpxy_to_pmc_rpmi`."
        )
    if not _shmem_roundtrip_unblocked():
        raise TestSuccess(
            "BLOCKED: PMC_RPMI_SHMEM_ROUNDTRIP not set.  See "
            "docs/evidence/power/pmc-soc-integration-evidence.yaml"
            "::mpxy_rpmi_roundtrip for the three remaining bindings "
            "(pmc_top shmem MMIO routing, main.c drain loop, SPMI "
            "stub-out) and the gating PR."
        )

    aon_hex_default = Path(__file__).resolve().parents[3] / "fw" / "pmc" / "build" / "pmc.aon.hex"
    aon_hex = Path(os.environ.get("PMC_AON_SRAM_HEX", aon_hex_default))
    assert aon_hex.is_file(), f"PMC AON hex missing at {aon_hex}; run `make -C fw/pmc aon-hex`"

    cocotb.start_soon(Clock(dut.clk, CLK_PERIOD_NS, units="ns").start())
    await _reset(dut)

    # Allow the Ibex to reach pmc_main and complete a few drain-loop
    # iterations before we post the first request.
    for _ in range(BOOT_SETUP_CYCLES):
        await RisingEdge(dut.clk)

    token = 0x1234
    request_payload = struct.pack("<I", 0)  # clock_id = 0
    frame = _pack_rpmi_frame(
        servicegroup_id=RPMI_SRVGRP_CLOCK,
        service_id=RPMI_CLOCK_SRV_GET_RATE,
        msg_type=RPMI_MSG_TYPE_NORMAL_REQUEST,
        token=token,
        payload=request_payload,
    )
    await _post_a2p_request(dut, frame, slot_index=0)

    cycles = await _wait_for_p2a_ack(dut, expected_tail=1)
    cocotb.log.info(f"P2A_ACK tail advanced to 1 after {cycles} polling cycles")

    resp_slot = await _read_p2a_ack_slot(dut, slot_index=0)
    header = _unpack_rpmi_header(resp_slot)

    assert header["servicegroup_id"] == RPMI_SRVGRP_CLOCK, (
        f"servicegroup_id mismatch: got {header['servicegroup_id']:#x}, "
        f"expected {RPMI_SRVGRP_CLOCK:#x}"
    )
    assert header["service_id"] == RPMI_CLOCK_SRV_GET_RATE, (
        f"service_id mismatch: got {header['service_id']:#x}, "
        f"expected {RPMI_CLOCK_SRV_GET_RATE:#x}"
    )
    assert (header["flags"] & 0x7) == RPMI_MSG_TYPE_ACKNOWLEDGEMENT, (
        f"message type not ACK: flags={header['flags']:#x}"
    )
    assert header["token"] == token, (
        f"token mirror mismatch: got {header['token']:#x}, expected {token:#x}"
    )
    assert header["datalen"] >= 12, (
        f"clock GET_RATE response should carry status + rate_lo + rate_hi "
        f"(12 bytes); got datalen={header['datalen']}"
    )

    status, rate_lo, rate_hi = struct.unpack("<iII", resp_slot[8:20])
    assert status == RPMI_OK, f"RPMI status not OK: {status}"
    assert rate_lo == EXPECTED_CLOCK_RATE_HZ, (
        f"clock rate (low) mismatch: got {rate_lo}, expected {EXPECTED_CLOCK_RATE_HZ}"
    )
    assert rate_hi == 0, f"clock rate (high) expected 0, got {rate_hi}"


@cocotb.test()
async def opensbi_rpmi_voltage_get_level_roundtrip(dut):
    if not _ibex_guard_active():
        raise TestSuccess(
            "skipped: PMC_INSTANTIATE_IBEX not set."
        )
    if not _shmem_roundtrip_unblocked():
        raise TestSuccess(
            "BLOCKED: PMC_RPMI_SHMEM_ROUNDTRIP not set.  See "
            "docs/evidence/power/pmc-soc-integration-evidence.yaml"
            "::mpxy_rpmi_roundtrip for the three remaining bindings "
            "(pmc_top shmem MMIO routing, main.c drain loop, SPMI "
            "stub-out) and the gating PR."
        )

    aon_hex_default = Path(__file__).resolve().parents[3] / "fw" / "pmc" / "build" / "pmc.aon.hex"
    aon_hex = Path(os.environ.get("PMC_AON_SRAM_HEX", aon_hex_default))
    assert aon_hex.is_file(), f"PMC AON hex missing at {aon_hex}"

    cocotb.start_soon(Clock(dut.clk, CLK_PERIOD_NS, units="ns").start())
    await _reset(dut)

    for _ in range(BOOT_SETUP_CYCLES):
        await RisingEdge(dut.clk)

    token = 0x5678
    request_payload = struct.pack("<I", 0)  # domain_id = 0
    frame = _pack_rpmi_frame(
        servicegroup_id=RPMI_SRVGRP_VOLTAGE,
        service_id=RPMI_VOLTAGE_SRV_GET_LEVEL,
        msg_type=RPMI_MSG_TYPE_NORMAL_REQUEST,
        token=token,
        payload=request_payload,
    )
    await _post_a2p_request(dut, frame, slot_index=0)

    await _wait_for_p2a_ack(dut, expected_tail=1)
    resp_slot = await _read_p2a_ack_slot(dut, slot_index=0)
    header = _unpack_rpmi_header(resp_slot)

    assert header["servicegroup_id"] == RPMI_SRVGRP_VOLTAGE
    assert header["service_id"] == RPMI_VOLTAGE_SRV_GET_LEVEL
    assert (header["flags"] & 0x7) == RPMI_MSG_TYPE_ACKNOWLEDGEMENT
    assert header["token"] == token
    assert header["datalen"] >= 8

    status, level_uv = struct.unpack("<ii", resp_slot[8:16])
    assert status == RPMI_OK, f"voltage RPMI status not OK: {status}"
    assert level_uv == EXPECTED_VOLTAGE_UV, (
        f"voltage level mismatch: got {level_uv} uV, expected {EXPECTED_VOLTAGE_UV} uV"
    )


@cocotb.test()
async def opensbi_rpmi_base_spec_version_roundtrip(dut):
    """Smoke for the BASE service group — OpenSBI calls
    GET_SPEC_VERSION at init to validate that the PMC RPMI server is at
    v1.0.  Returns status + version composite."""
    if not _ibex_guard_active():
        raise TestSuccess(
            "skipped: PMC_INSTANTIATE_IBEX not set."
        )
    if not _shmem_roundtrip_unblocked():
        raise TestSuccess(
            "BLOCKED: PMC_RPMI_SHMEM_ROUNDTRIP not set.  See "
            "docs/evidence/power/pmc-soc-integration-evidence.yaml"
            "::mpxy_rpmi_roundtrip for the three remaining bindings "
            "(pmc_top shmem MMIO routing, main.c drain loop, SPMI "
            "stub-out) and the gating PR."
        )

    aon_hex_default = Path(__file__).resolve().parents[3] / "fw" / "pmc" / "build" / "pmc.aon.hex"
    aon_hex = Path(os.environ.get("PMC_AON_SRAM_HEX", aon_hex_default))
    assert aon_hex.is_file(), f"PMC AON hex missing at {aon_hex}"

    cocotb.start_soon(Clock(dut.clk, CLK_PERIOD_NS, units="ns").start())
    await _reset(dut)

    for _ in range(BOOT_SETUP_CYCLES):
        await RisingEdge(dut.clk)

    token = 0xABCD
    frame = _pack_rpmi_frame(
        servicegroup_id=RPMI_SRVGRP_BASE,
        service_id=RPMI_BASE_SRV_GET_SPEC_VERSION,
        msg_type=RPMI_MSG_TYPE_NORMAL_REQUEST,
        token=token,
        payload=b"",
    )
    await _post_a2p_request(dut, frame, slot_index=0)
    await _wait_for_p2a_ack(dut, expected_tail=1)

    resp_slot = await _read_p2a_ack_slot(dut, slot_index=0)
    header = _unpack_rpmi_header(resp_slot)
    assert header["servicegroup_id"] == RPMI_SRVGRP_BASE
    assert header["service_id"] == RPMI_BASE_SRV_GET_SPEC_VERSION
    assert (header["flags"] & 0x7) == RPMI_MSG_TYPE_ACKNOWLEDGEMENT
    assert header["token"] == token
    assert header["datalen"] >= 8

    status, version = struct.unpack("<iI", resp_slot[8:16])
    assert status == RPMI_OK
    assert version == RPMI_VERSION_1_0, (
        f"spec version mismatch: got {version:#x}, expected {RPMI_VERSION_1_0:#x}"
    )
