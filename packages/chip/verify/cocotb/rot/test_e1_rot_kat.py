"""Functional crypto-datapath KAT for the E1 RoT control crossbar.

Drives the e1_rot_xbar host port (tlul_adapter_host -> tlul_socket_1n, vendored
OpenTitan TL-UL fabric) exactly as the RoT Ibex data port would, programs the
real OpenTitan HMAC block to compute SHA-256("abc"), reads the digest back
through the same datapath, and asserts it matches the FIPS 180-4 known answer.

This is the gate's "functional crypto result": the digest is produced by the
real vendored hmac/sha2 RTL, fetched over the real TL-UL host adapter and 1->N
socket, with command/response integrity generated and checked by the vendored
adapters. A shim or tie-off cannot produce this value.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles, RisingEdge, Timer

# HMAC sits on device window 3; each window is 4 KiB (DEV_WIN_LSB=12).
HMAC_BASE = 3 << 12

# hmac_reg_pkg byte offsets.
HMAC_INTR_STATE = HMAC_BASE + 0x00
HMAC_CFG = HMAC_BASE + 0x10
HMAC_CMD = HMAC_BASE + 0x14
HMAC_DIGEST_0 = HMAC_BASE + 0x44
HMAC_MSG_FIFO = HMAC_BASE + 0x800

# CFG fields: hmac_en[0], sha_en[1], endian_swap[2], digest_swap[3].
CFG_SHA_EN = 1 << 1

# CMD fields: hash_start[0], hash_process[1].
CMD_HASH_START = 1 << 0
CMD_HASH_PROCESS = 1 << 1

# INTR_STATE: hmac_done[0].
INTR_HMAC_DONE = 1 << 0

# SHA-256("abc") per FIPS 180-4, as eight big-endian 32-bit words.
SHA256_ABC = [
    0xBA7816BF,
    0x8F01CFEA,
    0x414140DE,
    0x5DAE2223,
    0xB00361A3,
    0x96177A9C,
    0xB410FF61,
    0xF20015AD,
]


async def _reset(dut):
    dut.host_req_i.value = 0
    dut.host_addr_i.value = 0
    dut.host_we_i.value = 0
    dut.host_wdata_i.value = 0
    dut.host_be_i.value = 0
    dut.rst_ni.value = 0
    await ClockCycles(dut.clk_i, 5)
    dut.rst_ni.value = 1
    await ClockCycles(dut.clk_i, 2)


async def _host_xact(dut, addr, *, we, wdata=0, be=0xF):
    """Run one TL-UL host transaction through the crossbar; return read data.

    tlul_adapter_host (MAX_REQS=1) presents gnt as a_ready and rvalid as
    d_valid. Hold req until granted, then wait for the response beat.
    """
    dut.host_addr_i.value = addr
    dut.host_we_i.value = 1 if we else 0
    dut.host_wdata_i.value = wdata
    dut.host_be_i.value = be if we else 0xF
    dut.host_req_i.value = 1

    # Wait for grant (a_ready). Bounded to avoid a hang on a wiring break.
    for _ in range(64):
        await RisingEdge(dut.clk_i)
        if dut.host_gnt_o.value == 1:
            break
    else:
        raise TimeoutError(f"no grant for addr=0x{addr:x} we={we}")
    dut.host_req_i.value = 0

    # Wait for the response beat (d_valid). The socket FIFOs add latency.
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


@cocotb.test()
async def hmac_sha256_kat_through_xbar(dut):
    """SHA-256("abc") computed by the real HMAC block, fetched via the xbar."""
    cocotb.start_soon(Clock(dut.clk_i, 10, units="ns").start())
    await _reset(dut)

    assert dut.host_intg_err_o.value == 0, "spurious TL-UL integrity error at reset"

    # Configure SHA-256 mode. endian_swap=0 / digest_swap=0: the DIGEST
    # registers then read in the engine's native (big-endian, FIPS 180-4) word
    # order, so DIGEST_0 == the first FIPS digest word with no SW byte-swap.
    await _write(dut, HMAC_CFG, CFG_SHA_EN)

    # Start hashing, push "abc", then process. With endian_swap=0 the message
    # byte stream is the FIFO word in big-endian byte order, so "abc" (a is the
    # first/most-significant byte of the stream) is word 0x00616263 with the low
    # three byte-enables set (3 bytes => MSG_LENGTH = 24 bits).
    await _write(dut, HMAC_CMD, CMD_HASH_START)
    await _write(dut, HMAC_MSG_FIFO, 0x00616263, be=0x7)
    await _write(dut, HMAC_CMD, CMD_HASH_PROCESS)

    # Poll hmac_done.
    for _ in range(2000):
        if (await _read(dut, HMAC_INTR_STATE)) & INTR_HMAC_DONE:
            break
        await ClockCycles(dut.clk_i, 4)
    else:
        raise TimeoutError("HMAC never asserted hmac_done")

    digest = []
    for i in range(8):
        digest.append(await _read(dut, HMAC_DIGEST_0 + 4 * i))

    assert digest == SHA256_ABC, (
        "HMAC SHA-256(\"abc\") mismatch through RoT crossbar:\n"
        f"  got      {[hex(d) for d in digest]}\n"
        f"  expected {[hex(d) for d in SHA256_ABC]}"
    )
    dut._log.info(
        "RoT datapath KAT PASS: SHA-256(\"abc\") = "
        + "".join(f"{d:08x}" for d in digest)
        + " via tlul_adapter_host -> tlul_socket_1n -> real OpenTitan hmac"
    )
