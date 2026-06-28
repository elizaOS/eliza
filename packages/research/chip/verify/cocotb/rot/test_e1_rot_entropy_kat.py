"""Functional entropy-stack KAT for the E1 RoT control crossbar.

Drives the e1_rot_xbar host port (tlul_adapter_host -> tlul_socket_1n, vendored
OpenTitan TL-UL fabric) exactly as the RoT Ibex data port would, brings up the
real entropy interconnect (entropy_src -> csrng -> edn, e1_rot_ot_entropy_stack)
over the register windows, then programs the real OpenTitan KMAC block to hash a
plain SHA3-256 message while sourcing its masking entropy from the real EDN
(CFG.entropy_mode = EdnMode). The digest is read back as the XOR of the two
masked Keccak state shares and asserted against the FIPS 202 known answer.

This is the gate's entropy-stack "functional result": KMAC has EnMasking=1, so
it cannot complete a hash without consuming entropy. With entropy_mode = EdnMode
that entropy can only come from the EDN endpoint, which is fed by the real
csrng/entropy_src chain. A shim, tie-off, or stalled entropy stack would leave
KMAC hung in StRandReady forever (the test would time out) -- only a live
entropy_src -> csrng -> edn -> kmac datapath lets the hash finish AND produces
the correct unmasked digest.

ENTROPY MODE / HONESTY CAVEAT: entropy_src is brought up in BOOT-TIME BYPASS
mode (CONF.enable set, FIPS conditioner bypassed) fed by a DETERMINISTIC
behavioral RNG model (e1_rot_rng_model). This proves the digital entropy
datapath end to end in simulation; it is NOT a FIPS / SP800-90B entropy claim.
Production FIPS bring-up (real AST noise source, full health-test windows, the
KMAC conditioner in FIPS mode) is the documented remainder.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles, RisingEdge, Timer

# Device windows (4 KiB each, DEV_WIN_LSB=12), matching e1_rot_entropy_kat_tb.
KMAC_BASE = 2 << 12
CSRNG_BASE = 5 << 12
EDN_BASE = 6 << 12
ES_BASE = 7 << 12

# entropy_src register offsets (entropy_src_reg_pkg).
ES_REGWEN = ES_BASE + 0x10
ES_CONF = ES_BASE + 0x18
ES_ENTROPY_CONTROL = ES_BASE + 0x20

# csrng register offsets (csrng_reg_pkg).
CSRNG_CTRL = CSRNG_BASE + 0x14

# edn register offsets (edn_reg_pkg).
EDN_REGWEN = EDN_BASE + 0x10
EDN_CTRL = EDN_BASE + 0x14

# kmac register offsets (kmac_reg_pkg).
KMAC_INTR_STATE = KMAC_BASE + 0x00
KMAC_CFG_REGWEN = KMAC_BASE + 0x10
KMAC_CFG = KMAC_BASE + 0x14
KMAC_CMD = KMAC_BASE + 0x18
KMAC_STATUS = KMAC_BASE + 0x1C
KMAC_STATE_SHARE0 = KMAC_BASE + 0x400
KMAC_STATE_SHARE1 = KMAC_BASE + 0x500
KMAC_MSG_FIFO = KMAC_BASE + 0x800

# entropy_src CONF.enable is a 2-bit field; any non-zero value enables (the core
# uses `es_enable = |enable.q`). 0x3 == both bits set.
ES_CONF_ENABLE = 0x3

# csrng CTRL.enable is bit 0; aes_cipher stays enabled (aes_cipher_disable=0).
CSRNG_CTRL_ENABLE = 0x1

# edn CTRL: EDN_ENABLE[0]=1, HW_REQ_MODE[3:2]=2 (BOOT mode). In boot mode EDN
# autonomously instantiates+generates from CSRNG and serves the endpoints.
EDN_CTRL_BOOT = 0x1 | (0x2 << 2)

# kmac CFG: kmac_en=0 (plain SHA3, not keyed), kstrength[3:1]=2 (L256),
# mode[5:4]=0 (SHA3), entropy_mode[17:16]=1 (EdnMode), entropy_fast_process[19],
# entropy_ready[24].
KMAC_CFG_VAL = (2 << 1) | (1 << 16) | (1 << 19) | (1 << 24)

# kmac CMD enum: start=1, process=2, done=8.
KMAC_CMD_START = 1
KMAC_CMD_PROCESS = 2
KMAC_CMD_DONE = 8

# kmac INTR_STATE: kmac_done[0].
KMAC_INTR_DONE = 1 << 0

# kmac STATUS: sha3_idle[0], sha3_absorb[1], sha3_squeeze[2].
KMAC_STATUS_SQUEEZE = 1 << 2

# SHA3-256("") per FIPS 202, as eight little-endian 32-bit words read from the
# Keccak state window (the state is stored LSB-first; the standard digest is
# a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a).
SHA3_256_EMPTY = [
    0xF8C6FFA7,
    0x66D71EBF,
    0x5647C151,
    0x62D661A0,
    0x4DFF80F5,
    0xFA493BE4,
    0x4B0AD882,
    0x4A43F880,
]


async def _reset(dut):
    dut.host_req_i.value = 0
    dut.host_addr_i.value = 0
    dut.host_we_i.value = 0
    dut.host_wdata_i.value = 0
    dut.host_be_i.value = 0
    dut.rst_ni.value = 0
    await ClockCycles(dut.clk_i, 8)
    dut.rst_ni.value = 1
    await ClockCycles(dut.clk_i, 4)


async def _host_xact(dut, addr, *, we, wdata=0, be=0xF):
    """Run one TL-UL host transaction through the crossbar; return read data."""
    dut.host_addr_i.value = addr
    dut.host_we_i.value = 1 if we else 0
    dut.host_wdata_i.value = wdata
    dut.host_be_i.value = be if we else 0xF
    dut.host_req_i.value = 1

    for _ in range(64):
        await RisingEdge(dut.clk_i)
        if dut.host_gnt_o.value == 1:
            break
    else:
        raise TimeoutError(f"no grant for addr=0x{addr:x} we={we}")
    dut.host_req_i.value = 0

    rdata = 0
    for _ in range(256):
        await Timer(1, units="ns")
        if dut.host_rvalid_o.value == 1:
            rdata = int(dut.host_rdata_o.value)
            assert dut.host_err_o.value == 0, f"TL-UL error response for addr=0x{addr:x} we={we}"
            break
        await RisingEdge(dut.clk_i)
    else:
        raise TimeoutError(f"no response for addr=0x{addr:x} we={we}")
    await RisingEdge(dut.clk_i)
    return rdata


async def _write(dut, addr, data, be=0xF):
    await _host_xact(dut, addr, we=True, wdata=data, be=be)


async def _read(dut, addr):
    return await _host_xact(dut, addr, we=False)


@cocotb.test()
async def kmac_sha3_kat_edn_entropy(dut):
    """SHA3-256("") by real KMAC sourcing masking entropy from the real EDN."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())
    await _reset(dut)

    assert dut.host_intg_err_o.value == 0, "spurious TL-UL integrity error at reset"

    # --- Bring up the entropy stack over the register windows. ---
    # entropy_src: boot-time bypass (FIPS conditioner bypassed). Setting CONF
    # locks REGWEN, so program CONF last among entropy_src writes. ENTROPY_CONTROL
    # left at reset (es_route=0 -> entropy routed to hardware, not SW).
    await _write(dut, ES_ENTROPY_CONTROL, 0x0)
    await _write(dut, ES_CONF, ES_CONF_ENABLE)

    # csrng: enable (AES cipher core on).
    await _write(dut, CSRNG_CTRL, CSRNG_CTRL_ENABLE)

    # edn: boot-request mode -> autonomous instantiate + generate from CSRNG and
    # serve endpoints. This is the edge that delivers entropy to KMAC.
    await _write(dut, EDN_CTRL, EDN_CTRL_BOOT)

    # Let the entropy_src boot-bypass window fill and csrng/edn instantiate from
    # it. The behavioral RNG emits a nibble every cycle, so the boot window and
    # the CTR_DRBG instantiate complete within a few thousand cycles.
    await ClockCycles(dut.clk_i, 4000)

    # --- Program KMAC for a plain SHA3-256 hash, EDN-sourced masking entropy. ---
    await _write(dut, KMAC_CFG, KMAC_CFG_VAL)

    # Start absorbing, push the empty message (process with no message bytes),
    # then issue process.
    await _write(dut, KMAC_CMD, KMAC_CMD_START)
    await _write(dut, KMAC_CMD, KMAC_CMD_PROCESS)

    # Poll kmac_done. If the EDN never delivers entropy, KMAC stalls in its
    # entropy-ready state and this times out -- the fail-closed signal that the
    # entropy datapath is not live.
    for _ in range(20000):
        if (await _read(dut, KMAC_INTR_STATE)) & KMAC_INTR_DONE:
            break
        await ClockCycles(dut.clk_i, 8)
    else:
        raise TimeoutError(
            "KMAC never asserted kmac_done -- entropy stack did not deliver "
            "EDN entropy (entropy_src -> csrng -> edn -> kmac)"
        )

    # SHA3 is now in the squeeze stage; read both masked state shares and XOR to
    # recover the unmasked digest (EnMasking=1 splits the state across 2 shares).
    digest = []
    for i in range(8):
        share0 = await _read(dut, KMAC_STATE_SHARE0 + 4 * i)
        share1 = await _read(dut, KMAC_STATE_SHARE1 + 4 * i)
        digest.append(share0 ^ share1)

    # Tell KMAC the result is consumed.
    await _write(dut, KMAC_CMD, KMAC_CMD_DONE)

    assert digest == SHA3_256_EMPTY, (
        'KMAC SHA3-256("") mismatch through RoT crossbar + entropy stack:\n'
        f"  got      {[hex(d) for d in digest]}\n"
        f"  expected {[hex(d) for d in SHA3_256_EMPTY]}"
    )
    dut._log.info(
        'RoT entropy-stack KAT PASS: SHA3-256("") = '
        + "".join(f"{d:08x}" for d in digest)
        + " via real KMAC with masking entropy from entropy_src -> csrng -> edn"
    )
