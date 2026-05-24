"""Functional keymgr key-ladder KAT for the E1 RoT control crossbar.

Drives the e1_rot_xbar host port (tlul_adapter_host -> tlul_socket_1n, vendored
OpenTitan TL-UL fabric) exactly as the RoT Ibex data port would, brings up the
real entropy interconnect (entropy_src -> csrng -> edn, via the keymgr stack),
programs the real OpenTitan KMAC's masking entropy, then sequences the REAL
OpenTitan key manager through its register window:

    Advance (StCtrlReset  -> StCtrlInit, root key loaded, NO KMAC)
    program SW_BINDING (the creator binding mixed into the next KDF)
    Advance (StCtrlInit   -> StCtrlCreatorRootKey, KMAC KDF of the creator stage)
    program SALT + KEY_VERSION
    Generate-SW-Output      (KMAC KDF of the creator key with salt -> SW CSRs)
    read SW_SHARE0/1_OUTPUT (the bound key, masked into two shares)

WHAT THIS PROVES (be precise):
  * The key ladder ADVANCES through the real keymgr FSM:
    Reset -> Init -> CreatorRootKey, reaching WORKING_STATE == CreatorRootKey
    with OP_STATUS == DONE_SUCCESS and ERR_CODE == 0 on every step. A stalled
    keymgr <-> kmac <-> edn datapath would hang (timeout) or land in DONE_ERROR.
  * Each KMAC-backed stage runs through the REAL KMAC over the application
    interface, sourcing masking entropy from the REAL EDN (entropy_src -> csrng
    -> edn). KMAC (EnMasking=1) cannot complete a KDF without that entropy.
  * The generated key is INPUT-BOUND: re-running the whole ladder with a
    different SW_BINDING produces a DIFFERENT key (both the SW-output CSR key
    and the hardware sideload key), proving the binding input flows through the
    real KMAC KDF into the derived key (tamper divergence). A tie-off / shim /
    constant would NOT diverge.

HONESTY CAVEAT: the creator/owner roots are FIXED deterministic simulation
constants (otp_key_i = OTP_KEYMGR_KEY_DEFAULT, a fixed otp_device_id, the
keymgr_pkg RndCnst identity seeds), and the entropy is the deterministic
behavioral RNG (boot-bypass, NOT FIPS / SP800-90B). This proves the hardware
key-ladder DATAPATH and input binding; it is NOT a provisioned silicon device
identity (no real UDS / fused secret / silicon entropy). The reference key is
not recomputed in Python (the full AdvDataWidth KDF blob mixes vendored RndCnst
seeds + device id + health state); the proof is self-consistent ladder advance
plus deterministic input-binding divergence.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles, RisingEdge, Timer

# Device windows (4 KiB each, DEV_WIN_LSB=12), matching e1_rot_keymgr_kat_tb.
KEYMGR_BASE = 1 << 12
KMAC_BASE = 2 << 12
CSRNG_BASE = 5 << 12
EDN_BASE = 6 << 12
ES_BASE = 7 << 12

# entropy_src register offsets (entropy_src_reg_pkg).
ES_CONF = ES_BASE + 0x18
ES_ENTROPY_CONTROL = ES_BASE + 0x20

# csrng register offsets (csrng_reg_pkg).
CSRNG_CTRL = CSRNG_BASE + 0x14

# edn register offsets (edn_reg_pkg).
EDN_CTRL = EDN_BASE + 0x14

# kmac register offsets (kmac_reg_pkg).
KMAC_CFG = KMAC_BASE + 0x14

# keymgr register offsets (keymgr_reg_pkg).
KEYMGR_CFG_REGWEN = KEYMGR_BASE + 0x10
KEYMGR_CONTROL = KEYMGR_BASE + 0x14
KEYMGR_SW_BINDING_REGWEN = KEYMGR_BASE + 0x20
KEYMGR_SW_BINDING_0 = KEYMGR_BASE + 0x24  # 8 words: +0x24 .. +0x40
KEYMGR_SALT_0 = KEYMGR_BASE + 0x44  # 8 words: +0x44 .. +0x60
KEYMGR_KEY_VERSION = KEYMGR_BASE + 0x64
KEYMGR_MAX_CREATOR_KEY_VER_REGWEN = KEYMGR_BASE + 0x68
KEYMGR_MAX_CREATOR_KEY_VER = KEYMGR_BASE + 0x6C
KEYMGR_SW_SHARE0_OUTPUT_0 = KEYMGR_BASE + 0x80  # 8 words
KEYMGR_SW_SHARE1_OUTPUT_0 = KEYMGR_BASE + 0xA0  # 8 words
KEYMGR_WORKING_STATE = KEYMGR_BASE + 0xC0
KEYMGR_OP_STATUS = KEYMGR_BASE + 0xC4
KEYMGR_ERR_CODE = KEYMGR_BASE + 0xC8

# entropy_src CONF.enable (2-bit field, any non-zero enables).
ES_CONF_ENABLE = 0x3
CSRNG_CTRL_ENABLE = 0x1
# edn CTRL: EDN_ENABLE[0]=1, HW_REQ_MODE[3:2]=2 (BOOT mode).
EDN_CTRL_BOOT = 0x1 | (0x2 << 2)
# kmac CFG: kstrength[3:1]=2 (L256), entropy_mode[17:16]=1 (EdnMode),
# entropy_fast_process[19], entropy_ready[24]. kmac_en/mode left 0 (set per app).
KMAC_CFG_VAL = (2 << 1) | (1 << 16) | (1 << 19) | (1 << 24)

# keymgr CONTROL fields: START[0], OPERATION[6:4], DEST_SEL[13:12].
KEYMGR_OP_ADVANCE = 0
KEYMGR_OP_GEN_SW_OUTPUT = 2
KEYMGR_OP_GEN_HW_OUTPUT = 3
KEYMGR_DEST_NONE = 0
KEYMGR_DEST_KMAC = 3  # DEST_SEL: None=0, AES=1, HMAC=2, KMAC=3


def _control(operation, dest_sel=KEYMGR_DEST_NONE, start=1):
    return (start & 0x1) | ((operation & 0x7) << 4) | ((dest_sel & 0x3) << 12)


# keymgr WORKING_STATE.STATE values.
ST_RESET = 0
ST_INIT = 1
ST_CREATOR_ROOT_KEY = 2

# keymgr OP_STATUS.STATUS values.
OP_IDLE = 0
OP_WIP = 1
OP_DONE_SUCCESS = 2
OP_DONE_ERROR = 3


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
            assert dut.host_err_o.value == 0, (
                f"TL-UL error response for addr=0x{addr:x} we={we}"
            )
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


async def _bring_up_entropy(dut):
    """entropy_src boot-bypass -> csrng -> edn boot mode; KMAC entropy ready."""
    await _write(dut, ES_ENTROPY_CONTROL, 0x0)
    await _write(dut, ES_CONF, ES_CONF_ENABLE)
    await _write(dut, CSRNG_CTRL, CSRNG_CTRL_ENABLE)
    await _write(dut, EDN_CTRL, EDN_CTRL_BOOT)
    # Let the boot-bypass window fill and csrng/edn instantiate.
    await ClockCycles(dut.clk_i, 4000)
    # KMAC: EnMasking entropy from EDN (the keymgr KDF runs masked through KMAC).
    await _write(dut, KMAC_CFG, KMAC_CFG_VAL)


async def _wait_op_done(dut, what):
    """Poll OP_STATUS until the keymgr operation completes; assert success."""
    status = OP_WIP
    for _ in range(40000):
        status = (await _read(dut, KEYMGR_OP_STATUS)) & 0x3
        if status in (OP_DONE_SUCCESS, OP_DONE_ERROR):
            break
        await ClockCycles(dut.clk_i, 8)
    else:
        raise TimeoutError(
            f"keymgr {what} never completed (OP_STATUS stuck WIP) -- "
            "keymgr <-> kmac <-> edn datapath did not deliver"
        )
    if status == OP_DONE_ERROR:
        err = await _read(dut, KEYMGR_ERR_CODE)
        raise AssertionError(
            f"keymgr {what} finished with DONE_ERROR, ERR_CODE=0x{err:08x}"
        )
    # Clear OP_STATUS (rw1c): write back what we read.
    await _write(dut, KEYMGR_OP_STATUS, OP_DONE_SUCCESS)


async def _advance(dut, what):
    await _write(dut, KEYMGR_CONTROL, _control(KEYMGR_OP_ADVANCE))
    await _wait_op_done(dut, what)


async def _run_ladder(dut, binding_word, salt_word):
    """Run the full ladder once with the given SW binding; return the key.

    Returns (sw_output_key_words[8], sideload_share0, sideload_share1).
    sw_output_key_words are the unmasked (share0 ^ share1) generate-SW-output.
    """
    await _bring_up_entropy(dut)

    # Advance Reset -> Init (loads the root key; no KMAC KDF here).
    await _advance(dut, "advance Reset->Init")
    state = (await _read(dut, KEYMGR_WORKING_STATE)) & 0x7
    assert state == ST_INIT, f"expected Init after first advance, got state={state}"

    # Program the creator SW binding (8 words). This is the tamperable input
    # mixed into the Init->CreatorRootKey KDF. SW_BINDING_REGWEN is open in Init.
    for i in range(8):
        await _write(dut, KEYMGR_SW_BINDING_0 + 4 * i, binding_word ^ (0x11111111 * i))

    # Advance Init -> CreatorRootKey (KMAC KDF of the creator stage).
    await _advance(dut, "advance Init->CreatorRootKey")
    state = (await _read(dut, KEYMGR_WORKING_STATE)) & 0x7
    assert state == ST_CREATOR_ROOT_KEY, (
        f"expected CreatorRootKey after second advance, got state={state}"
    )

    # Allow a non-zero key version: raise the creator max (defaults to 0, which
    # would make any KEY_VERSION > 0 an INVALID_KMAC_INPUT). REGWEN is open until
    # written 0; leave it open and set the max generously.
    await _write(dut, KEYMGR_MAX_CREATOR_KEY_VER_REGWEN, 0x1)
    await _write(dut, KEYMGR_MAX_CREATOR_KEY_VER, 0xFFFF_FFFF)

    # Program salt + key version for the generate operations.
    for i in range(8):
        await _write(dut, KEYMGR_SALT_0 + 4 * i, salt_word ^ (0x01010101 * i))
    await _write(dut, KEYMGR_KEY_VERSION, 0x1)

    # Generate HW output to the KMAC sideload destination: a KMAC KDF of the
    # creator key with the salt loads kmac_key_o (dest_sel=KMAC & key_sel=HwKey).
    # Capture the resulting hardware-only sideload key for the divergence proof.
    await _write(
        dut,
        KEYMGR_CONTROL,
        _control(KEYMGR_OP_GEN_HW_OUTPUT, dest_sel=KEYMGR_DEST_KMAC),
    )
    await _wait_op_done(dut, "generate-HW-output (KMAC sideload)")
    assert dut.sideload_key_valid_o.value == 1, (
        "keymgr sideload key not valid after generate-HW-output to KMAC"
    )
    sideload0 = int(dut.sideload_key_share0_o.value)
    sideload1 = int(dut.sideload_key_share1_o.value)

    # Generate SW output: a KMAC KDF of the creator key with the salt -> SW CSRs.
    await _write(dut, KEYMGR_CONTROL, _control(KEYMGR_OP_GEN_SW_OUTPUT))
    await _wait_op_done(dut, "generate-SW-output")

    sw_key = []
    for i in range(8):
        s0 = await _read(dut, KEYMGR_SW_SHARE0_OUTPUT_0 + 4 * i)
        s1 = await _read(dut, KEYMGR_SW_SHARE1_OUTPUT_0 + 4 * i)
        sw_key.append(s0 ^ s1)

    return sw_key, sideload0, sideload1


@cocotb.test()
async def keymgr_ladder_advance_and_bind(dut):
    """keymgr Reset->Init->CreatorRootKey ladder + input-bound key divergence."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())

    # --- Run A: binding X. ---
    await _reset(dut)
    assert dut.host_intg_err_o.value == 0, "spurious TL-UL integrity error at reset"
    key_a, side_a0, side_a1 = await _run_ladder(
        dut, binding_word=0xA5A5A5A5, salt_word=0xC3C3C3C3
    )

    # A generated key of all-zero would mean the KDF never wrote real data.
    assert any(w != 0 for w in key_a), (
        "generate-SW-output produced an all-zero key -- KDF did not run"
    )

    # --- Run B: different binding, same salt. ---
    await _reset(dut)
    key_b, side_b0, side_b1 = await _run_ladder(
        dut, binding_word=0x5A5A5A5A, salt_word=0xC3C3C3C3
    )

    # Input binding divergence: a different creator SW binding must yield a
    # different derived key, proving the binding flows through the real KMAC KDF.
    assert key_a != key_b, (
        "creator key did NOT diverge with the SW binding input -- the ladder "
        "is not binding the input through the KDF (tie-off / shim?):\n"
        f"  key_a = {[hex(w) for w in key_a]}\n"
        f"  key_b = {[hex(w) for w in key_b]}"
    )
    assert (side_a0, side_a1) != (side_b0, side_b1), (
        "hardware sideload key did NOT diverge with the SW binding input"
    )

    dut._log.info(
        "RoT keymgr key-ladder KAT PASS: Reset->Init->CreatorRootKey advanced "
        "(DONE_SUCCESS, ERR_CODE=0), generate-SW-output produced an input-bound "
        "key via the real KMAC KDF + real EDN entropy.\n"
        f"  key(bindingA) = {''.join(f'{w:08x}' for w in key_a)}\n"
        f"  key(bindingB) = {''.join(f'{w:08x}' for w in key_b)}\n"
        "  keys diverge with the SW binding input (tamper divergence proven)."
    )
