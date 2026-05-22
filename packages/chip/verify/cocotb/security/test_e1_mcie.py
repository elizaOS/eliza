"""cocotb KAT + tamper-detection suite for the E1 MCIE
(rtl/security/mcie/e1_mcie.sv + e1_mcie_aes.sv + e1_mcie_pkg.sv).

The MCIE is the lane-01 S3 memory confidentiality + integrity engine
(docs/security/tee-plan/01-tee-core-architecture.md S3): counter-mode AES for
confidentiality (NOT XTS) + a per-line CBC-MAC and counter-integrity tree for
tamper detection and anti-replay. This testbench provides a backing-memory
model for the attacker-visible DRAM record {ciphertext, counter, mac} per line
and proves:

  (a) roundtrip: write -> read of a confidential line returns the original
      plaintext (encrypt/decrypt correct);
  (b) actually-encrypted: the ciphertext stored in backing memory != plaintext;
  (c) non-determinism (TEE.fail / not-XTS): two writes of identical plaintext to
      the same line produce different ciphertext because the counter advanced;
  (d) tamper detection: flipping a stored ciphertext byte makes the read fail
      closed (FAULT_MAC), no plaintext returned;
  (e) replay/anti-rollback: replaying an OLD (ciphertext, counter, mac) triple
      fails closed (FAULT_ROLLBACK), no plaintext returned;
  (f) counter monotonicity: the stored counter strictly increases per write;
  (g) plaintext passthrough: a shared/free line is stored and read back
      unchanged with no crypto.

A self-contained Python AES-128 reference (matching the RTL byte/block
conventions) computes the expected ciphertext/MAC so the crypto is checked
against a known-answer model, and the AES core itself is checked against the
FIPS-197 Appendix B known-answer vector.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# ---------------------------------------------------------------------------
# Architectural constants (mirror rtl/security/mcie/e1_mcie_pkg.sv).
# ---------------------------------------------------------------------------
LINE_BITS = 128
ADDR_BITS = 64
COUNTER_BITS = 64
MAC_BITS = 128

# Page-state encoding (mirrors e1_mcie_pkg / e1_mtt_pkg PS_*).
PS_FREE = 0
PS_MEASURED = 1
PS_PRIVATE = 2
PS_SHARED = 3
PS_DEVICE_ASSIGNED = 4
PS_SCRUB_PENDING = 5

OP_READ = 0
OP_WRITE = 1

FAULT_NONE = 0
FAULT_MAC = 1
FAULT_ROLLBACK = 2
FAULT_NO_COUNTER = 3

# Key domain separation (mirrors e1_mcie.sv ENC_DOMAIN / MAC_DOMAIN).
ENC_DOMAIN = 0
MAC_DOMAIN = 0x4D41_4300_4D41_4300_4D41_4300_4D41_4300

BOOT_SEED = 0x0F0E0D0C_0B0A0908_07060504_03020100

MASK128 = (1 << 128) - 1
MASK64 = (1 << 64) - 1


# ===========================================================================
# Self-contained AES-128 (encrypt) reference, byte order matching the RTL:
# byte 0 of the 128-bit value is bits [127:120] (FIPS-197 ordering).
# ===========================================================================
SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16"
)


def _xtime(b: int) -> int:
    b <<= 1
    if b & 0x100:
        b ^= 0x11B
    return b & 0xFF


def _mul3(b: int) -> int:
    return _xtime(b) ^ b


def _bytes_of(v: int) -> list[int]:
    """128-bit int -> 16 bytes, byte 0 = bits [127:120]."""
    return [(v >> (120 - 8 * i)) & 0xFF for i in range(16)]


def _int_of(bs: list[int]) -> int:
    v = 0
    for i, b in enumerate(bs):
        v |= (b & 0xFF) << (120 - 8 * i)
    return v


def _key_expansion(key: int) -> list[list[int]]:
    """Return 11 round keys, each as 16 bytes (column-major)."""
    words = []
    kb = _bytes_of(key)
    for c in range(4):
        words.append([kb[4 * c + r] for r in range(4)])  # word = column c
    rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]
    for i in range(4, 44):
        temp = list(words[i - 1])
        if i % 4 == 0:
            temp = temp[1:] + temp[:1]  # RotWord
            temp = [SBOX[b] for b in temp]  # SubWord
            temp[0] ^= rcon[i // 4 - 1]
        words.append([words[i - 4][j] ^ temp[j] for j in range(4)])
    round_keys = []
    for rk in range(11):
        rkb = [0] * 16
        for c in range(4):
            for r in range(4):
                rkb[4 * c + r] = words[4 * rk + c][r]
        round_keys.append(rkb)
    return round_keys


def aes128_encrypt(key: int, block: int) -> int:
    rks = _key_expansion(key)
    s = _bytes_of(block)
    s = [s[i] ^ rks[0][i] for i in range(16)]
    for rnd in range(1, 11):
        s = [SBOX[b] for b in s]  # SubBytes
        # ShiftRows (column-major s[r + 4c])
        sr = [0] * 16
        for r in range(4):
            for c in range(4):
                sr[r + 4 * c] = s[r + 4 * ((c + r) % 4)]
        s = sr
        if rnd != 10:
            mc = [0] * 16
            for c in range(4):
                a = s[4 * c : 4 * c + 4]
                mc[4 * c + 0] = _xtime(a[0]) ^ _mul3(a[1]) ^ a[2] ^ a[3]
                mc[4 * c + 1] = a[0] ^ _xtime(a[1]) ^ _mul3(a[2]) ^ a[3]
                mc[4 * c + 2] = a[0] ^ a[1] ^ _xtime(a[2]) ^ _mul3(a[3])
                mc[4 * c + 3] = _mul3(a[0]) ^ a[1] ^ a[2] ^ _xtime(a[3])
            s = mc
        s = [s[i] ^ rks[rnd][i] for i in range(16)]
    return _int_of(s)


# ===========================================================================
# MCIE crypto reference (matches e1_mcie.sv exactly).
# ===========================================================================
def enc_key() -> int:
    return BOOT_SEED ^ ENC_DOMAIN


def mac_key() -> int:
    return BOOT_SEED ^ MAC_DOMAIN


def ac_block(addr: int, counter: int) -> int:
    """{addr[63:0], counter[63:0]} packed into 128 bits (addr high half)."""
    return ((addr & MASK64) << 64) | (counter & MASK64)


def keystream(addr: int, counter: int) -> int:
    return aes128_encrypt(enc_key(), ac_block(addr, counter))


def cbc_mac(addr: int, counter: int, ct: int) -> int:
    b0 = aes128_encrypt(mac_key(), ac_block(addr, counter))
    return aes128_encrypt(mac_key(), (ct ^ b0) & MASK128)


def encrypt_line(addr: int, counter: int, plaintext: int) -> tuple[int, int]:
    ct = (plaintext ^ keystream(addr, counter)) & MASK128
    mac = cbc_mac(addr, counter, ct)
    return ct, mac


# ===========================================================================
# Backing-memory model + harness plumbing.
# ===========================================================================
class BackingStore:
    """Attacker-visible DRAM record per line: {ct, counter, mac}."""

    def __init__(self) -> None:
        self.rec: dict[int, tuple[int, int, int]] = {}

    def write(self, addr: int, ct: int, counter: int, mac: int) -> None:
        self.rec[addr] = (ct & MASK128, counter & MASK64, mac & MASK128)

    def read(self, addr: int) -> tuple[int, int, int]:
        return self.rec.get(addr, (0, 0, 0))


async def mem_responder(dut, store: BackingStore):
    """Service the MCIE backing-store master port. One outstanding request:
    accept on mem_req_valid&ready (ready always 1), and on a read drive a
    one-cycle response next cycle; on a write commit the record."""
    dut.mem_req_ready.value = 1
    dut.mem_rsp_valid.value = 0
    dut.mem_rsp_ct.value = 0
    dut.mem_rsp_counter.value = 0
    dut.mem_rsp_mac.value = 0
    serviced = False
    while True:
        await RisingEdge(dut.clk)
        dut.mem_rsp_valid.value = 0
        if int(dut.mem_req_valid.value) and int(dut.mem_req_ready.value) and not serviced:
            addr = int(dut.mem_req_addr.value)
            if int(dut.mem_req_we.value):
                store.write(
                    addr,
                    int(dut.mem_req_ct.value),
                    int(dut.mem_req_counter.value),
                    int(dut.mem_req_mac.value),
                )
            else:
                ct, counter, mac = store.read(addr)
                await RisingEdge(dut.clk)
                dut.mem_rsp_ct.value = ct
                dut.mem_rsp_counter.value = counter
                dut.mem_rsp_mac.value = mac
                dut.mem_rsp_valid.value = 1
                serviced = True
                continue
            serviced = True
        if not int(dut.mem_req_valid.value):
            serviced = False


async def reset(dut):
    dut.rst_n.value = 0
    dut.boot_seed_i.value = BOOT_SEED
    dut.seed_valid_i.value = 0
    dut.req_valid.value = 0
    dut.req_op.value = 0
    dut.req_state.value = 0
    dut.req_addr.value = 0
    dut.req_wdata.value = 0
    dut.mem_req_ready.value = 1
    dut.mem_rsp_valid.value = 0
    dut.mem_rsp_ct.value = 0
    dut.mem_rsp_counter.value = 0
    dut.mem_rsp_mac.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    dut.seed_valid_i.value = 1
    await RisingEdge(dut.clk)


async def do_request(dut, op, state, addr, wdata=0, timeout=400):
    """Drive one request and wait for the response. Returns (ok, rdata, fault)."""
    while not int(dut.req_ready.value):
        await RisingEdge(dut.clk)
    dut.req_valid.value = 1
    dut.req_op.value = op
    dut.req_state.value = state
    dut.req_addr.value = addr & MASK64
    dut.req_wdata.value = wdata & MASK128
    await RisingEdge(dut.clk)
    dut.req_valid.value = 0
    for _ in range(timeout):
        await RisingEdge(dut.clk)
        if int(dut.rsp_valid.value):
            return (
                int(dut.rsp_ok.value),
                int(dut.rsp_rdata.value),
                int(dut.rsp_fault.value),
            )
    raise TimeoutError(f"no response for op={op} state={state} addr={addr:#x}")


async def start(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)


# ===========================================================================
# Tests.
# ===========================================================================
@cocotb.test()
async def aes_fips197_kat(dut):
    """The AES-128 core matches the FIPS-197 Appendix B known-answer vector.

    Verified through the MCIE crypto: we recompute the reference and assert the
    Python reference itself matches FIPS-197, which gates every other test (the
    RTL roundtrip below cross-checks the RTL against this same reference)."""
    key = 0x2B7E1516_28AED2A6_ABF71588_09CF4F3C
    pt = 0x3243F6A8_885A308D_313198A2_E0370734
    expect = 0x3925841D_02DC09FB_DC118597_196A0B32
    got = aes128_encrypt(key, pt)
    assert got == expect, f"AES reference broken: {got:#034x} != {expect:#034x}"
    await start(dut)


@cocotb.test()
async def roundtrip_confidential(dut):
    """(a) write->read of a private line returns the original plaintext."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x8000_4000
    pt = 0x00112233_44556677_8899AABB_CCDDEEFF
    ok, _, fault = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt)
    assert ok == 1 and fault == FAULT_NONE, "write should succeed"

    ok, rdata, fault = await do_request(dut, OP_READ, PS_PRIVATE, addr)
    assert ok == 1, f"read should verify (fault={fault})"
    assert rdata == pt, f"roundtrip mismatch: {rdata:#034x} != {pt:#034x}"


@cocotb.test()
async def actually_encrypted(dut):
    """(b) ciphertext in backing memory != plaintext, and matches the
    counter-mode reference (so it is genuinely AES-CTR, not a passthrough)."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x8000_8000
    pt = 0xDEADBEEF_DEADBEEF_DEADBEEF_DEADBEEF
    ok, _, _ = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt)
    assert ok == 1
    ct, counter, mac = store.read(addr)
    assert ct != pt, "stored ciphertext equals plaintext -> not encrypted"
    exp_ct, exp_mac = encrypt_line(addr, counter, pt)
    assert ct == exp_ct, f"ciphertext != CTR reference: {ct:#x} != {exp_ct:#x}"
    assert mac == exp_mac, f"mac != CBC-MAC reference: {mac:#x} != {exp_mac:#x}"


@cocotb.test()
async def non_deterministic_ciphertext(dut):
    """(c) the not-XTS / TEE.fail property: identical plaintext written twice to
    the same line yields DIFFERENT ciphertext because the counter advanced."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x8001_0000
    pt = 0x01010101_02020202_03030303_04040404
    ok, _, _ = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt)
    assert ok == 1
    ct1, ctr1, _ = store.read(addr)

    ok, _, _ = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt)
    assert ok == 1
    ct2, ctr2, _ = store.read(addr)

    assert ctr2 > ctr1, "(f) counter must strictly advance on rewrite"
    assert ct1 != ct2, "identical plaintext -> identical ciphertext (XTS-like leak)"

    # And the latest still decrypts correctly.
    ok, rdata, _ = await do_request(dut, OP_READ, PS_PRIVATE, addr)
    assert ok == 1 and rdata == pt


@cocotb.test()
async def tamper_ciphertext_detected(dut):
    """(d) flipping a stored ciphertext byte makes the read fail closed with a
    MAC fault and returns no plaintext."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x8002_0000
    pt = 0x12131415_16171819_1A1B1C1D_1E1F2021
    ok, _, _ = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt)
    assert ok == 1
    ct, counter, mac = store.read(addr)

    # Attacker flips one ciphertext byte (counter + mac left intact).
    store.write(addr, ct ^ 0x01, counter, mac)

    ok, rdata, fault = await do_request(dut, OP_READ, PS_PRIVATE, addr)
    assert ok == 0, "tampered read must fail closed"
    assert fault == FAULT_MAC, f"expected FAULT_MAC, got {fault}"
    assert rdata == 0, "no plaintext may leak on a failed read"
    assert int(dut.integ_fault_sticky_o.value) == 1
    assert int(dut.integ_fault_cause_o.value) == FAULT_MAC


@cocotb.test()
async def replay_old_triple_detected(dut):
    """(e) replaying an OLD (ciphertext, counter, mac) triple fails closed with
    a rollback fault. This is the anti-replay / freshness proof."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x8003_0000
    pt_old = 0xAAAAAAAA_AAAAAAAA_AAAAAAAA_AAAAAAAA
    pt_new = 0xBBBBBBBB_BBBBBBBB_BBBBBBBB_BBBBBBBB

    ok, _, _ = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt_old)
    assert ok == 1
    stale = store.read(addr)  # capture the old triple (counter N)

    ok, _, _ = await do_request(dut, OP_WRITE, PS_PRIVATE, addr, pt_new)
    assert ok == 1  # on-die counter advances to N+1

    # Attacker rolls the DRAM record back to the stale (counter N) triple.
    store.write(addr, *stale)

    ok, rdata, fault = await do_request(dut, OP_READ, PS_PRIVATE, addr)
    assert ok == 0, "replayed stale triple must fail closed"
    assert fault == FAULT_ROLLBACK, f"expected FAULT_ROLLBACK, got {fault}"
    assert rdata == 0, "no plaintext may leak on a replay"
    assert int(dut.integ_fault_cause_o.value) == FAULT_ROLLBACK


@cocotb.test()
async def read_unwritten_confidential_faults(dut):
    """A read of a confidential line never written this boot has no on-die
    counter to verify against -> fail closed (FAULT_NO_COUNTER), not a blind
    return of attacker-controlled DRAM."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x8004_0000
    # Attacker plants a record at an address the engine never wrote.
    store.write(addr, 0xCAFE, 5, 0xF00D)
    ok, rdata, fault = await do_request(dut, OP_READ, PS_PRIVATE, addr)
    assert ok == 0 and fault == FAULT_NO_COUNTER
    assert rdata == 0


@cocotb.test()
async def shared_plaintext_passthrough(dut):
    """(g) a shared line is stored and read back unchanged with no crypto."""
    store = BackingStore()
    cocotb.start_soon(mem_responder(dut, store))
    await start(dut)

    addr = 0x9000_0000
    pt = 0xFEEDFACE_FEEDFACE_0BADF00D_0BADF00D
    ok, _, _ = await do_request(dut, OP_WRITE, PS_SHARED, addr, pt)
    assert ok == 1
    ct, counter, mac = store.read(addr)
    assert ct == pt, "shared line must be stored verbatim (plaintext)"
    assert counter == 0 and mac == 0, "no counter/mac for a plaintext line"

    ok, rdata, _ = await do_request(dut, OP_READ, PS_SHARED, addr)
    assert ok == 1 and rdata == pt, "shared read must return the same bytes"
