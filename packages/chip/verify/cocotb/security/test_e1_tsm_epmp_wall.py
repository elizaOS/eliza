"""cocotb suite for the E1 TSM Smepmp/ePMP protection wall
(rtl/security/tsm/e1_tsm_epmp_wall.sv).

This is the Dorami-pattern intra-M-mode wall (docs/security/tee-plan/
01-tee-core-architecture.md S1, work item W4): a synthesizable Smepmp
permission checker that isolates the tiny M-mode TEE Security Manager (TSM)
from the untrusted OpenSBI that shares M-mode. The proof obligation is the
real Smepmp truth table -- in particular that once the TSM region is locked
M-only under mseccfg.MML, an untrusted-M-mode (OpenSBI-emulated) read / write /
execute INTO the TSM region is DENIED, while the TSM's own access pattern is
permitted; that MMWP makes unmatched M-mode accesses default-deny; that RLB=0
freezes locked rules until reset; and that S/U accesses to the TSM region are
denied.

Programming model mirrors rtl/security/otp/e1_otp_map.sv and
rtl/iommu/e1_iopmp.sv: a measured-launch launcher programs pmpaddr/pmpcfg +
mseccfg through the MMIO slave, then clears RLB to seal the wall.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# ---------------------------------------------------------------------------
# Register map (mirrors rtl/security/tsm/e1_tsm_epmp_wall.sv).
# ---------------------------------------------------------------------------
OFF_MSECCFG = 0x000
OFF_STATUS = 0x004
OFF_CFG0 = 0x010
OFF_ADDR0 = 0x040

# mseccfg / status bits.
MML = 1 << 0
MMWP = 1 << 1
RLB = 1 << 2
STATUS_LOCKED = 1 << 3

# pmpcfg byte bits.
CFG_R = 1 << 0
CFG_W = 1 << 1
CFG_X = 1 << 2
A_OFF = 0 << 3
A_TOR = 1 << 3
A_NA4 = 2 << 3
A_NAPOT = 3 << 3
CFG_L = 1 << 7

# Privilege modes (priv_e).
PRIV_U = 0b00
PRIV_S = 0b01
PRIV_M = 0b11

# Access types (access_e).
ACC_FETCH = 0b00
ACC_READ = 0b01
ACC_WRITE = 0b10

# The wall is parameterised PADDR_W=56 / NUM_ENT=8 by default. pmpaddr is
# byte-address >> 2.
ADDR_SHIFT = 2

# TSM regions chosen as NAPOT ranges (byte addresses). Entry layout:
#   entry 0: TSM CODE  region, M execute-only        (L=1, X=1)
#   entry 1: TSM DATA  region, M-only R/W no-execute (L=1, R=1, W=1)
#   entry 2: shared trampoline gate                  (L=0, X=1 shared)
TSM_CODE_BASE = 0x8000_0000
TSM_CODE_SIZE = 0x1000  # 4 KiB
TSM_DATA_BASE = 0x8000_2000
TSM_DATA_SIZE = 0x1000
GATE_BASE = 0x8000_4000
GATE_SIZE = 0x1000

# An address that no rule covers (used for the MMWP default-deny proof).
UNMATCHED_ADDR = 0x9000_0000


def napot_encode(base: int, size: int) -> int:
    """Encode a (base, power-of-two size>=8) byte range as a pmpaddr NAPOT
    value (byte address >> 2 with trailing ones marking the size)."""
    assert size >= 8 and (size & (size - 1)) == 0, "NAPOT size must be 2^n >= 8"
    assert base % size == 0, "NAPOT base must be size-aligned"
    return (base >> ADDR_SHIFT) | ((size >> (ADDR_SHIFT + 1)) - 1)


# ---------------------------------------------------------------------------
# Bus helpers (custom shape: separate programming slave + check port).
# ---------------------------------------------------------------------------
async def reset(dut):
    dut.rst_n.value = 0
    dut.reg_valid.value = 0
    dut.reg_write.value = 0
    dut.reg_addr.value = 0
    dut.reg_wdata.value = 0
    dut.chk_valid.value = 0
    dut.chk_priv.value = 0
    dut.chk_addr.value = 0
    dut.chk_type.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def reg_write(dut, addr, data):
    dut.reg_addr.value = addr
    dut.reg_wdata.value = data
    dut.reg_write.value = 1
    dut.reg_valid.value = 1
    await RisingEdge(dut.clk)
    dut.reg_valid.value = 0
    dut.reg_write.value = 0
    await Timer(1, units="ns")


async def reg_read(dut, addr):
    dut.reg_addr.value = addr
    dut.reg_write.value = 0
    dut.reg_valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.reg_rdata.value)
    await RisingEdge(dut.clk)
    dut.reg_valid.value = 0
    await Timer(1, units="ns")
    return value


async def write_cfg(dut, entry, cfg_byte):
    """Program a single pmpcfg byte (read-modify-write the packed word)."""
    word_off = OFF_CFG0 + (entry // 4) * 4
    cur = await reg_read(dut, word_off)
    lane = entry % 4
    cur &= ~(0xFF << (lane * 8))
    cur |= (cfg_byte & 0xFF) << (lane * 8)
    await reg_write(dut, word_off, cur)


async def write_addr(dut, entry, pmpaddr):
    await reg_write(dut, OFF_ADDR0 + entry * 4, pmpaddr)


async def check(dut, priv, addr, acc):
    """Drive the combinational check port and return (allow, deny)."""
    dut.chk_priv.value = priv
    dut.chk_addr.value = addr
    dut.chk_type.value = acc
    dut.chk_valid.value = 1
    await Timer(1, units="ns")
    allow = int(dut.chk_allow.value)
    deny = int(dut.chk_deny.value)
    dut.chk_valid.value = 0
    await Timer(1, units="ns")
    return allow, deny


async def program_and_lock_tsm_wall(dut):
    """Emulate the measured-launch launcher: program the TSM regions, set MML +
    MMWP, then clear RLB to seal the wall (RLB=0 -> locked rules immutable)."""
    # entry 0: TSM CODE -- M execute-only, locked.
    await write_addr(dut, 0, napot_encode(TSM_CODE_BASE, TSM_CODE_SIZE))
    await write_cfg(dut, 0, CFG_L | A_NAPOT | CFG_X)
    # entry 1: TSM DATA -- M-only R/W, no-execute, locked.
    await write_addr(dut, 1, napot_encode(TSM_DATA_BASE, TSM_DATA_SIZE))
    await write_cfg(dut, 1, CFG_L | A_NAPOT | CFG_R | CFG_W)
    # entry 2: shared trampoline gate -- shared execute (L=0, X=1), the only
    # controlled M<->TSM entry point. Shared so both compartments may fetch it.
    await write_addr(dut, 2, napot_encode(GATE_BASE, GATE_SIZE))
    await write_cfg(dut, 2, A_NAPOT | CFG_X)
    # Arm Smepmp: MML (truth-table reinterpretation) + MMWP (default-deny).
    await reg_write(dut, OFF_MSECCFG, MML | MMWP | RLB)
    # Seal: clear RLB. Locked rules are now immutable until reset.
    await reg_write(dut, OFF_MSECCFG, MML | MMWP)  # RLB bit not set -> cleared


# ===========================================================================
# Tests
# ===========================================================================
async def _start(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)


@cocotb.test()
async def reset_posture_fail_closed(dut):
    """At reset, RLB=1 (programmable), MML/MMWP=0, no rule enabled. A check on a
    valid M-mode access matching no rule is PERMITTED only because MMWP=0 (legacy
    bring-up); under MMWP/MML it must flip to deny -- verified later. S/U with no
    rule is always denied."""
    await _start(dut)
    assert int(dut.rlb_o.value) == 1, "RLB should reset to 1 (launcher window open)"
    assert int(dut.mml_o.value) == 0
    assert int(dut.mmwp_o.value) == 0
    assert int(dut.locked_o.value) == 0
    # S/U with no matching rule -> deny (architectural).
    allow, deny = await check(dut, PRIV_S, TSM_DATA_BASE, ACC_READ)
    assert allow == 0 and deny == 1, "S-mode unmatched must deny"
    allow, deny = await check(dut, PRIV_U, TSM_DATA_BASE, ACC_READ)
    assert allow == 0 and deny == 1, "U-mode unmatched must deny"


@cocotb.test()
async def launcher_programs_before_lock(dut):
    """Before lock the launcher can program pmpaddr/pmpcfg and read them back."""
    await _start(dut)
    await write_addr(dut, 0, napot_encode(TSM_CODE_BASE, TSM_CODE_SIZE))
    await write_cfg(dut, 0, CFG_L | A_NAPOT | CFG_X)
    rb_addr = await reg_read(dut, OFF_ADDR0 + 0 * 4)
    assert rb_addr == napot_encode(TSM_CODE_BASE, TSM_CODE_SIZE), "pmpaddr0 readback"
    rb_cfg = await reg_read(dut, OFF_CFG0) & 0xFF
    assert rb_cfg == (CFG_L | A_NAPOT | CFG_X), f"pmpcfg0 readback {rb_cfg:#x}"


@cocotb.test()
async def tsm_own_access_permitted(dut):
    """After lock, the TSM's own access pattern is PERMITTED:
      - M-mode fetch from TSM CODE  (execute-only region)
      - M-mode read/write of TSM DATA (R/W region)
    This is the positive control for the deny tests below."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    allow, deny = await check(dut, PRIV_M, TSM_CODE_BASE + 0x40, ACC_FETCH)
    assert allow == 1 and deny == 0, "TSM M-mode fetch of its own code must pass"
    allow, deny = await check(dut, PRIV_M, TSM_DATA_BASE + 0x40, ACC_READ)
    assert allow == 1 and deny == 0, "TSM M-mode read of its own data must pass"
    allow, deny = await check(dut, PRIV_M, TSM_DATA_BASE + 0x40, ACC_WRITE)
    assert allow == 1 and deny == 0, "TSM M-mode write of its own data must pass"


@cocotb.test()
async def untrusted_mmode_read_into_tsm_denied(dut):
    """THE proof: untrusted M-mode (OpenSBI) READ into the TSM CODE region is
    DENIED. TSM CODE is L=1,X=1 (M execute-only): under MML, M-mode has X but
    NOT R, so a data read faults -- OpenSBI cannot exfiltrate TSM code."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    allow, deny = await check(dut, PRIV_M, TSM_CODE_BASE + 0x10, ACC_READ)
    assert allow == 0 and deny == 1, "untrusted M-mode READ of TSM code must DENY"


@cocotb.test()
async def untrusted_mmode_write_into_tsm_denied(dut):
    """Untrusted M-mode WRITE into the TSM CODE region is DENIED (M execute-only
    has no W) -- OpenSBI cannot patch/tamper TSM code. A WRITE into the TSM DATA
    region from M-mode is permitted by the truth table (M-only R/W); the
    intra-M-mode 'which subject' separation that stops OpenSBI from reaching the
    data region is the TSM trampoline's job (follow-on), so the hardware proof
    here is the execute-only code region being unwritable."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    allow, deny = await check(dut, PRIV_M, TSM_CODE_BASE + 0x10, ACC_WRITE)
    assert allow == 0 and deny == 1, "untrusted M-mode WRITE of TSM code must DENY"


@cocotb.test()
async def untrusted_mmode_exec_of_tsm_data_denied(dut):
    """Untrusted M-mode EXECUTE (instruction fetch) from the TSM DATA region is
    DENIED. TSM DATA is L=1,R=1,W=1,X=0 (M-only R/W, no-execute): under MML
    M-mode has no X there, so jumping into TSM data faults -- a code-reuse /
    W^X violation is blocked."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    allow, deny = await check(dut, PRIV_M, TSM_DATA_BASE + 0x10, ACC_FETCH)
    assert allow == 0 and deny == 1, "M-mode EXECUTE of TSM data must DENY (W^X)"


@cocotb.test()
async def mmwp_default_deny_unmatched_mmode(dut):
    """MMWP default-deny: after MML+MMWP an M-mode access matching NO rule is
    DENIED (whitelist policy) -- the opposite of the reset legacy posture."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    allow, deny = await check(dut, PRIV_M, UNMATCHED_ADDR, ACC_READ)
    assert allow == 0 and deny == 1, "MMWP must default-deny unmatched M-mode"
    allow, deny = await check(dut, PRIV_M, UNMATCHED_ADDR, ACC_WRITE)
    assert allow == 0 and deny == 1
    allow, deny = await check(dut, PRIV_M, UNMATCHED_ADDR, ACC_FETCH)
    assert allow == 0 and deny == 1


@cocotb.test()
async def su_access_to_tsm_denied(dut):
    """S-mode and U-mode accesses to the TSM regions are DENIED. The TSM code
    and data regions are M-only/M-execute-only under MML, so the S/U column of
    the truth table grants nothing."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    for priv in (PRIV_S, PRIV_U):
        for base in (TSM_CODE_BASE, TSM_DATA_BASE):
            for acc in (ACC_READ, ACC_WRITE, ACC_FETCH):
                allow, deny = await check(dut, priv, base + 0x20, acc)
                assert allow == 0 and deny == 1, (
                    f"priv={priv} base={base:#x} acc={acc} must DENY"
                )


@cocotb.test()
async def rlb_zero_locked_rule_immutable(dut):
    """RLB=0 makes a post-lock rule rewrite have NO effect. After sealing, an
    attempt to widen TSM CODE to M-mode R/W/X is dropped, and the deny verdict
    is unchanged."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    assert int(dut.locked_o.value) == 1, "wall should be locked (MML & !RLB)"
    assert int(dut.rlb_o.value) == 0, "RLB must be cleared after seal"

    # Try to rewrite entry 0 cfg to L|R|W|X (would grant M-mode full access).
    await write_cfg(dut, 0, CFG_L | A_NAPOT | CFG_R | CFG_W | CFG_X)
    rb = await reg_read(dut, OFF_CFG0) & 0xFF
    assert rb == (CFG_L | A_NAPOT | CFG_X), f"locked cfg0 must be immutable, got {rb:#x}"
    # Try to relocate the region too -- also frozen.
    await write_addr(dut, 0, napot_encode(0xC000_0000, 0x1000))
    rb_addr = await reg_read(dut, OFF_ADDR0)
    assert rb_addr == napot_encode(TSM_CODE_BASE, TSM_CODE_SIZE), "locked pmpaddr immutable"

    # The deny verdict still holds.
    allow, deny = await check(dut, PRIV_M, TSM_CODE_BASE + 0x10, ACC_READ)
    assert allow == 0 and deny == 1, "still deny after failed rewrite"


@cocotb.test()
async def rlb_cannot_be_resurrected(dut):
    """RLB is sticky-clear: once 0 it can never be set back to 1, so locked
    rules can never be unlocked until reset."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    assert int(dut.rlb_o.value) == 0
    # Attempt to set RLB again.
    await reg_write(dut, OFF_MSECCFG, MML | MMWP | RLB)
    assert int(dut.rlb_o.value) == 0, "RLB must stay 0 (sticky-clear, immutable)"
    mseccfg = await reg_read(dut, OFF_MSECCFG)
    assert (mseccfg & RLB) == 0, "RLB readback must remain 0"


@cocotb.test()
async def mml_mmwp_sticky_set(dut):
    """MML and MMWP are sticky-set: once 1 they cannot be cleared (no clearing
    write can disarm the wall)."""
    await _start(dut)
    await reg_write(dut, OFF_MSECCFG, MML | MMWP | RLB)
    assert int(dut.mml_o.value) == 1 and int(dut.mmwp_o.value) == 1
    # Attempt to clear MML/MMWP by writing zeros to them.
    await reg_write(dut, OFF_MSECCFG, RLB)  # MML/MMWP bits low
    assert int(dut.mml_o.value) == 1, "MML must stay set (sticky)"
    assert int(dut.mmwp_o.value) == 1, "MMWP must stay set (sticky)"


@cocotb.test()
async def shared_gate_executable_both_modes(dut):
    """The shared trampoline gate (L=0, X=1 shared) is executable by M-mode and
    by S/U -- it is the controlled cross-compartment entry. It must NOT be
    writable (no W bit) by anyone."""
    await _start(dut)
    await program_and_lock_tsm_wall(dut)
    for priv in (PRIV_M, PRIV_S, PRIV_U):
        allow, deny = await check(dut, priv, GATE_BASE + 0x8, ACC_FETCH)
        assert allow == 1 and deny == 0, f"gate fetch priv={priv} must pass"
        allow, deny = await check(dut, priv, GATE_BASE + 0x8, ACC_WRITE)
        assert allow == 0 and deny == 1, f"gate write priv={priv} must DENY"


@cocotb.test()
async def tor_and_na4_matching(dut):
    """Exercise the TOR and NA4 address-matching modes (not just NAPOT) so the
    decode path is covered. Program (unlocked, MMWP off) so legacy M-mode passes
    matched rules per their R/W/X bits; verify a TOR range and an NA4 word."""
    await _start(dut)
    # Arm MML so the truth table applies, but leave RLB=1 so we can program.
    await reg_write(dut, OFF_MSECCFG, MML | RLB)
    # entry 0 is the TOR lower bound (A=OFF cfg, addr only used as bound).
    await write_addr(dut, 0, 0x7000_0000 >> ADDR_SHIFT)
    await write_cfg(dut, 0, A_OFF)
    # entry 1: TOR range [0x7000_0000, 0x7000_4000), M R/W (L=1,R=1,W=1).
    await write_addr(dut, 1, 0x7000_4000 >> ADDR_SHIFT)
    await write_cfg(dut, 1, CFG_L | A_TOR | CFG_R | CFG_W)
    allow, deny = await check(dut, PRIV_M, 0x7000_2000, ACC_READ)
    assert allow == 1 and deny == 0, "TOR in-range M read must pass"
    allow, deny = await check(dut, PRIV_M, 0x7000_5000, ACC_READ)
    # 0x7000_5000 is out of the TOR range; with MML set, unmatched M-mode where
    # MMWP is off is still permitted (legacy default), so this is allow.
    assert allow == 1, "MML w/o MMWP: unmatched M-mode permitted (legacy default)"

    # entry 2: NA4 single word at 0x7100_0000, M execute-only (L=1,X=1).
    await write_addr(dut, 2, 0x7100_0000 >> ADDR_SHIFT)
    await write_cfg(dut, 2, CFG_L | A_NA4 | CFG_X)
    allow, deny = await check(dut, PRIV_M, 0x7100_0000, ACC_FETCH)
    assert allow == 1 and deny == 0, "NA4 exact-word M fetch must pass"
    allow, deny = await check(dut, PRIV_M, 0x7100_0000, ACC_READ)
    assert allow == 0 and deny == 1, "NA4 execute-only: M read must DENY"
