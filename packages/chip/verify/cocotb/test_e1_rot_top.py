"""cocotb suite for the E1 root-of-trust integration top (W1).

Two contracts, both against real RTL (e1_rot_top + e1_rot_reset_seq +
e1_otp_map + e1_rot_mailbox):

  Reset-release sequence (docs/security/tee-plan/02-root-of-trust.md S1):
    1. After power-on reset the RoT comes out of reset first; the CVA6
       application cluster and the PMC are held in reset.
    2. On a verified measured boot (boot_verified_i then iopmp_policy_ready_i)
       the CVA6 cluster and PMC are released together.
    3. Fail-closed: if boot_verified_i never asserts, the cores stay in reset
       forever -- there is no timeout that releases them.
    4. Fail-closed: a lifecycle SCRAP state latches a hard halt and the cores
       never release even if a (spurious) boot_verified later asserts.

  Mailbox round-trip:
    5. AP writes a request (command + data) and rings the request doorbell;
       the RoT side observes REQ_PENDING and reads the captured request; the
       RoT writes a response + status and rings the response doorbell; the AP
       observes RESP_READY and reads the result. End-to-end through the real
       e1_rot_mailbox RTL.

The DUT is verify/cocotb/rot/e1_rot_top_tb.sv. The RoT Ibex is intentionally
NOT instantiated here: these contracts are about the reset sequencer and the
mailbox, which must hold regardless of RoT firmware. The Ibex-instantiated
elaboration is covered by the verilator elaboration leg of
scripts/check_rot_integration.py.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# Reset-sequencer state encoding (mirrors e1_rot_reset_seq state_e).
ST_ROT_RESET = 0
ST_ROT_RUN = 1
ST_WAIT_IOPMP = 2
ST_RELEASED = 3
ST_HALT = 4

# TL-UL opcodes (e1_rot_tlul_pkg).
OP_PUT_FULL = 0
OP_GET = 4

# Mailbox register word indices (e1_rot_mailbox).
REG_REQ_CMD = 0x00
REG_REQ_DOORBELL = 0x01
REG_STATUS = 0x02
REG_RESP_STATUS = 0x03
REG_RESP_DOORBELL = 0x04
REG_REQ_DATA0 = 0x08
REG_RESP_DATA0 = 0x18

CMD_ATTEST = 0x1


async def _start_clock(dut):
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())


def _idle(dut):
    dut.boot_verified_i.value = 0
    dut.iopmp_policy_ready_i.value = 0
    dut.lc_scrap_force.value = 0
    dut.mbox_a_valid.value = 0
    dut.mbox_a_opcode.value = OP_GET
    dut.mbox_a_source.value = 0
    dut.mbox_a_address.value = 0
    dut.mbox_a_data.value = 0
    dut.rot_valid_i.value = 0
    dut.rot_write_i.value = 0
    dut.rot_addr_i.value = 0
    dut.rot_wdata_i.value = 0
    dut.mbox2_a_valid.value = 0
    dut.mbox2_a_opcode.value = OP_GET
    dut.mbox2_a_source.value = 0
    dut.mbox2_a_address.value = 0
    dut.mbox2_a_data.value = 0


async def _reset(dut, *, scrap=False):
    _idle(dut)
    dut.lc_scrap_force.value = 1 if scrap else 0
    dut.rst_ni.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk_i)
    dut.rst_ni.value = 1
    await RisingEdge(dut.clk_i)


@cocotb.test()
async def rot_released_first_cores_held(dut):
    """After reset the RoT runs but CVA6/PMC are held in reset."""
    await _start_clock(dut)
    await _reset(dut)

    # A few cycles after reset the sequencer must be running the RoT but still
    # holding the application cluster + PMC.
    for _ in range(4):
        await RisingEdge(dut.clk_i)

    assert int(dut.reset_state_o.value) in (ST_ROT_RUN,), (
        f"expected ST_ROT_RUN, got state={int(dut.reset_state_o.value)}"
    )
    assert int(dut.cva6_rst_no.value) == 0, "CVA6 must be held in reset before verify"
    assert int(dut.pmc_rst_no.value) == 0, "PMC must be held in reset before verify"
    assert int(dut.platform_released_o.value) == 0


@cocotb.test()
async def cores_released_on_verified_boot(dut):
    """boot_verified -> iopmp_policy_ready releases CVA6 + PMC together."""
    await _start_clock(dut)
    await _reset(dut)
    for _ in range(3):
        await RisingEdge(dut.clk_i)

    # Assert the verified-boot strobe.
    dut.boot_verified_i.value = 1
    await RisingEdge(dut.clk_i)
    await RisingEdge(dut.clk_i)
    # Now in WAIT_IOPMP: cores still held until IOPMP policy is programmed.
    assert int(dut.cva6_rst_no.value) == 0, "cores must wait for IOPMP policy"
    assert int(dut.reset_state_o.value) == ST_WAIT_IOPMP

    dut.iopmp_policy_ready_i.value = 1
    await RisingEdge(dut.clk_i)
    await RisingEdge(dut.clk_i)

    assert int(dut.reset_state_o.value) == ST_RELEASED
    assert int(dut.platform_released_o.value) == 1
    assert int(dut.cva6_rst_no.value) == 1, "CVA6 must be released"
    assert int(dut.pmc_rst_no.value) == 1, "PMC must be released"


@cocotb.test()
async def cores_stay_in_reset_when_not_verified(dut):
    """Fail-closed: with boot_verified withheld the cores never release."""
    await _start_clock(dut)
    await _reset(dut)

    # Program IOPMP policy ready (out of order) but NEVER assert boot_verified.
    dut.iopmp_policy_ready_i.value = 1
    for _ in range(64):
        await RisingEdge(dut.clk_i)
        assert int(dut.cva6_rst_no.value) == 0, (
            "FAIL-CLOSED VIOLATION: CVA6 released without boot_verified"
        )
        assert int(dut.pmc_rst_no.value) == 0, (
            "FAIL-CLOSED VIOLATION: PMC released without boot_verified"
        )
    assert int(dut.platform_released_o.value) == 0
    assert int(dut.reset_state_o.value) == ST_ROT_RUN


@cocotb.test()
async def scrap_latches_halt_and_never_releases(dut):
    """Fail-closed: lifecycle SCRAP halts; cores never release."""
    await _start_clock(dut)
    await _reset(dut, scrap=True)

    for _ in range(8):
        await RisingEdge(dut.clk_i)
    assert int(dut.rot_halted_o.value) == 1, "SCRAP must latch the halt state"
    assert int(dut.reset_state_o.value) == ST_HALT

    # Even a (spurious) verified-boot must not release a SCRAP device.
    dut.boot_verified_i.value = 1
    dut.iopmp_policy_ready_i.value = 1
    for _ in range(32):
        await RisingEdge(dut.clk_i)
        assert int(dut.cva6_rst_no.value) == 0
        assert int(dut.pmc_rst_no.value) == 0
        assert int(dut.reset_state_o.value) == ST_HALT


# ---------------------------------------------------------------------------
# Mailbox round-trip (against the standalone u_mailbox_rt instance: same RTL).
# ---------------------------------------------------------------------------


async def _ap_write(dut, word, data):
    dut.mbox2_a_valid.value = 1
    dut.mbox2_a_opcode.value = OP_PUT_FULL
    dut.mbox2_a_address.value = word << 2
    dut.mbox2_a_data.value = data
    await RisingEdge(dut.clk_i)
    dut.mbox2_a_valid.value = 0
    await RisingEdge(dut.clk_i)


async def _ap_read(dut, word):
    dut.mbox2_a_valid.value = 1
    dut.mbox2_a_opcode.value = OP_GET
    dut.mbox2_a_address.value = word << 2
    await RisingEdge(dut.clk_i)
    dut.mbox2_a_valid.value = 0
    # Response is one-cycle latency.
    await RisingEdge(dut.clk_i)
    await Timer(1, units="ns")
    return int(dut.mbox2_d_data.value)


async def _rot_write(dut, word, data):
    dut.rot_valid_i.value = 1
    dut.rot_write_i.value = 1
    dut.rot_addr_i.value = word
    dut.rot_wdata_i.value = data
    await RisingEdge(dut.clk_i)
    dut.rot_valid_i.value = 0
    dut.rot_write_i.value = 0
    await RisingEdge(dut.clk_i)


async def _rot_read(dut, word):
    dut.rot_valid_i.value = 1
    dut.rot_write_i.value = 0
    dut.rot_addr_i.value = word
    await Timer(1, units="ns")
    val = int(dut.rot_rdata_o.value)
    await RisingEdge(dut.clk_i)
    dut.rot_valid_i.value = 0
    return val


@cocotb.test()
async def mailbox_request_response_roundtrip(dut):
    """AP request -> RoT consume -> RoT response -> AP read, end-to-end."""
    await _start_clock(dut)
    await _reset(dut)

    # AP composes a request: CMD_ATTEST + a data payload word.
    await _ap_write(dut, REG_REQ_CMD, CMD_ATTEST)
    await _ap_write(dut, REG_REQ_DATA0, 0xA5A50001)
    # Ring the request doorbell.
    await _ap_write(dut, REG_REQ_DOORBELL, 0x1)

    assert int(dut.mbox2_req_pending.value) == 1, "doorbell must set REQ_PENDING"

    # RoT side reads the request command + payload it received.
    cmd = await _rot_read(dut, REG_REQ_CMD)
    payload = await _rot_read(dut, REG_REQ_DATA0)
    assert cmd == CMD_ATTEST, f"RoT saw cmd={cmd:#x}, expected {CMD_ATTEST:#x}"
    assert payload == 0xA5A50001, f"RoT saw payload={payload:#x}"

    # RoT consumes the request (reading the request doorbell clears REQ_PENDING).
    await _rot_read(dut, REG_REQ_DOORBELL)
    await RisingEdge(dut.clk_i)
    await Timer(1, units="ns")
    assert int(dut.mbox2_req_pending.value) == 0, "consuming must clear REQ_PENDING"

    # RoT writes a response + status, then rings the response doorbell.
    await _rot_write(dut, REG_RESP_DATA0, 0xDEC0DE42)
    await _rot_write(dut, REG_RESP_STATUS, 0x0000_0001)  # success
    await _rot_write(dut, REG_RESP_DOORBELL, 0x1)

    assert int(dut.mbox2_resp_ready.value) == 1, "response doorbell must set RESP_READY"

    # AP reads the result back through the TL-UL host port.
    resp = await _ap_read(dut, REG_RESP_DATA0)
    status = await _ap_read(dut, REG_RESP_STATUS)
    assert resp == 0xDEC0DE42, f"AP read response={resp:#x}"
    assert status == 0x0000_0001, f"AP read status={status:#x}"

    # AP consumes the response (reading RESP_DOORBELL clears RESP_READY).
    await _ap_read(dut, REG_RESP_DOORBELL)
    await RisingEdge(dut.clk_i)
    assert int(dut.mbox2_resp_ready.value) == 0, "AP consume must clear RESP_READY"


@cocotb.test()
async def ap_cannot_write_response_bank(dut):
    """Isolation: the AP cannot forge a response (response bank is RoT-only)."""
    await _start_clock(dut)
    await _reset(dut)

    # AP attempts to write the response data + ring the response doorbell.
    await _ap_write(dut, REG_RESP_DATA0, 0xBADBAD00)
    await _ap_write(dut, REG_RESP_DOORBELL, 0x1)

    # The write must be dropped: no RESP_READY, and the response bank is untouched.
    assert int(dut.mbox2_resp_ready.value) == 0, (
        "ISOLATION VIOLATION: AP set RESP_READY"
    )
    resp = await _ap_read(dut, REG_RESP_DATA0)
    assert resp == 0x0, f"ISOLATION VIOLATION: AP wrote response bank ({resp:#x})"
