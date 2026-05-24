"""cocotb KAT for the E1 RISC-V AIA path: APLIC + IMSIC (rtl/interrupts/).

The Advanced Interrupt Architecture (AIA) is the modern RISC-V interrupt path
Linux uses for message-signalled interrupts (MSIs) and virtualization. This
suite drives the harness e1_aia_top (verify/cocotb/security/e1_aia_top.sv),
which wires e1_aplic's MSI emit port into e1_imsic's memory-mapped seteipnum
doorbell, and asserts the full delivery chain plus the TEE secure-domain
isolation required by docs/security/tee-plan/03-secure-io-iommu-npu.md §5.

Topology (harness params NUM_SOURCES=4, NUM_HARTS=1, NUM_IDS=63):
  * IMSIC flat files: file 0 = hart0 S/host file (world 0, doorbell page 0),
    file 1 = hart0 secure/monitor file (world 1, doorbell page 4096).
  * APLIC: M domain (parent) owns non-delegated sources; a source with
    sourcecfg.D=1 is delegated to the S (child) domain. Each domain has its own
    enable + target (dest file index, EIID, secure-world bit).

Asserted contracts:
  * device_msi_to_topei_claim: a device MSI write -> APLIC sourcecfg/target ->
    IMSIC EIP set -> topei returns the targeted identity -> claim clears it.
  * topei_priority_order: lower identity is higher priority (AIA ordering).
  * eie_masking: a disabled identity never reaches topei / raises irq.
  * m_to_s_delegation: sourcecfg.D routes a source to the S domain's target.
  * secure_domain_isolation: a confidential-domain MSI lands ONLY in the secure
    file; an untrusted-world MSI to the secure page is rejected and never sets a
    secure EIP (and a secure-world MSI to a host page is likewise rejected).
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

PAGE_BYTES = 4096
ID_W = 6  # $clog2(63 + 1)

# Flat IMSIC file indices in the harness.
FILE_HOST = 0    # hart0 S/host file, world 0
FILE_SECURE = 1  # hart0 secure/monitor file, world 1

# APLIC config field selectors (e1_aplic cfg_field_i).
F_SOURCECFG = 0
F_IE = 1
F_TARGET = 2

# APLIC domains.
DOM_M = 0
DOM_S = 1

# sourcecfg.sm encodings.
SM_INACTIVE = 0
SM_EDGE = 1
SM_LEVEL = 2


def _doorbell_addr(file_idx: int) -> int:
    return file_idx * PAGE_BYTES


def _sourcecfg(sm: int, delegate: bool) -> int:
    return (sm & 0x3) | (0x4 if delegate else 0x0)


def _target(file_idx: int, eiid: int, secure: bool) -> int:
    return (file_idx & 0x1) | ((eiid & 0x3F) << 16) | ((1 << 31) if secure else 0)


async def _reset(dut):
    dut.rst_n.value = 0
    dut.irq_sources.value = 0
    dut.cfg_we_i.value = 0
    dut.cfg_domain_i.value = 0
    dut.cfg_src_i.value = 0
    dut.cfg_field_i.value = 0
    dut.cfg_wdata_i.value = 0
    dut.dev_we_i.value = 0
    dut.dev_addr_i.value = 0
    dut.dev_id_i.value = 0
    dut.dev_world_i.value = 0
    dut.eie_we_i.value = 0
    dut.eie_id_i.value = 0
    dut.eie_val_i.value = 0
    dut.thr_we_i.value = 0
    dut.thr_val_i.value = 0
    dut.topei_claim_i.value = 0
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def _cfg(dut, domain: int, src: int, field: int, data: int):
    dut.cfg_we_i.value = 1
    dut.cfg_domain_i.value = domain
    dut.cfg_src_i.value = src
    dut.cfg_field_i.value = field
    dut.cfg_wdata_i.value = data
    await RisingEdge(dut.clk)
    dut.cfg_we_i.value = 0
    await RisingEdge(dut.clk)


async def _eie(dut, file_idx: int, ident: int, val: int):
    """Set/clear eie[ident] for a single flat file."""
    dut.eie_we_i.value = 1 << file_idx
    dut.eie_id_i.value = ident
    dut.eie_val_i.value = (val & 1) << file_idx
    await RisingEdge(dut.clk)
    dut.eie_we_i.value = 0
    await RisingEdge(dut.clk)


async def _dev_msi(dut, file_idx: int, ident: int, world: int):
    """A device / IOMMU MSI write straight to the IMSIC doorbell."""
    dut.dev_we_i.value = 1
    dut.dev_addr_i.value = _doorbell_addr(file_idx)
    dut.dev_id_i.value = ident
    dut.dev_world_i.value = world
    await RisingEdge(dut.clk)
    accept = int(dut.msi_accept_o.value)
    reject = int(dut.msi_reject_o.value)
    dut.dev_we_i.value = 0
    await RisingEdge(dut.clk)
    return accept, reject


async def _claim(dut, file_idx: int):
    """Pulse topei_claim for a file (clears the top identity)."""
    dut.topei_claim_i.value = 1 << file_idx
    await RisingEdge(dut.clk)
    dut.topei_claim_i.value = 0
    await RisingEdge(dut.clk)


def _topei_id(dut, file_idx: int) -> int:
    flat = int(dut.topei_id_flat_o.value)
    return (flat >> (file_idx * ID_W)) & ((1 << ID_W) - 1)


def _eip_any(dut, file_idx: int) -> int:
    return (int(dut.eip_any_o.value) >> file_idx) & 0x1


def _irq(dut, file_idx: int) -> int:
    return (int(dut.irq_o.value) >> file_idx) & 0x1


@cocotb.test()
async def device_msi_to_topei_claim(dut):
    """Device MSI -> APLIC sourcecfg/target -> IMSIC EIP -> topei -> claim clears."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # Program the host file to enable identity 7.
    await _eie(dut, FILE_HOST, 7, 1)

    # Path A: a raw device MSI write straight to the host doorbell (identity 7).
    accept, reject = await _dev_msi(dut, FILE_HOST, 7, world=0)
    assert accept == 1 and reject == 0, f"host MSI must be accepted (a={accept} r={reject})"
    await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 1, "host file should have a deliverable IRQ"
    assert _irq(dut, FILE_HOST) == 1, "host external IRQ line should assert"
    assert _topei_id(dut, FILE_HOST) == 7, f"topei should be 7, got {_topei_id(dut, FILE_HOST)}"

    # Claim clears it; the file goes quiet.
    await _claim(dut, FILE_HOST)
    assert _eip_any(dut, FILE_HOST) == 0, "claim must clear the pending identity"
    assert _topei_id(dut, FILE_HOST) == 0, "topei must read 0 after claim"

    # Path B: drive it through the APLIC. Source 2 (line bit 1), level mode,
    # M-domain enabled, targeting host file with EIID 7.
    await _cfg(dut, DOM_M, 2, F_SOURCECFG, _sourcecfg(SM_LEVEL, delegate=False))
    await _cfg(dut, DOM_M, 2, F_IE, 1)
    await _cfg(dut, DOM_M, 2, F_TARGET, _target(FILE_HOST, eiid=7, secure=False))

    dut.irq_sources.value = 1 << (2 - 1)  # assert source 2
    for _ in range(4):
        await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 1, "APLIC level source should pend an MSI in the host file"
    assert _topei_id(dut, FILE_HOST) == 7, "APLIC-delivered identity should be 7"
    dut.irq_sources.value = 0
    await _claim(dut, FILE_HOST)
    assert _eip_any(dut, FILE_HOST) == 0, "host file quiet after claim + line drop"


@cocotb.test()
async def topei_priority_order(dut):
    """Lower interrupt identity is higher priority (AIA ordering)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    await _eie(dut, FILE_HOST, 5, 1)
    await _eie(dut, FILE_HOST, 9, 1)

    # Set both identities pending via direct device MSIs.
    await _dev_msi(dut, FILE_HOST, 9, world=0)
    await _dev_msi(dut, FILE_HOST, 5, world=0)
    await RisingEdge(dut.clk)

    assert _topei_id(dut, FILE_HOST) == 5, f"lowest id (5) wins, got {_topei_id(dut, FILE_HOST)}"
    await _claim(dut, FILE_HOST)
    assert _topei_id(dut, FILE_HOST) == 9, f"after claiming 5, 9 surfaces, got {_topei_id(dut, FILE_HOST)}"
    await _claim(dut, FILE_HOST)
    assert _eip_any(dut, FILE_HOST) == 0, "both claimed -> file quiet"


@cocotb.test()
async def eie_masking(dut):
    """A pending-but-disabled identity never reaches topei or raises irq."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # Identity 11 is NOT enabled in the host file.
    accept, _ = await _dev_msi(dut, FILE_HOST, 11, world=0)
    assert accept == 1, "MSI write is accepted (EIP set) even if not enabled"
    await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 0, "disabled identity must not be deliverable"
    assert _irq(dut, FILE_HOST) == 0, "disabled identity must not raise irq"
    assert _topei_id(dut, FILE_HOST) == 0, "disabled identity must not appear in topei"

    # Enabling it now exposes it.
    await _eie(dut, FILE_HOST, 11, 1)
    await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 1, "enabling a pending identity exposes it"
    assert _topei_id(dut, FILE_HOST) == 11, "topei now reports the enabled identity"


@cocotb.test()
async def m_to_s_delegation(dut):
    """sourcecfg.D delegates a source from M to the S domain's target."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    await _eie(dut, FILE_HOST, 20, 1)

    # Source 3: delegate to S; the S-domain target/enable own it. The M-domain
    # enable/target are deliberately NOT set, proving ownership moved to S.
    await _cfg(dut, DOM_M, 3, F_SOURCECFG, _sourcecfg(SM_LEVEL, delegate=True))
    await _cfg(dut, DOM_S, 3, F_IE, 1)
    await _cfg(dut, DOM_S, 3, F_TARGET, _target(FILE_HOST, eiid=20, secure=False))

    dut.irq_sources.value = 1 << (3 - 1)
    for _ in range(4):
        await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 1, "delegated source should deliver via the S target"
    assert _topei_id(dut, FILE_HOST) == 20, "S-domain EIID should be delivered"

    dut.irq_sources.value = 0
    await _claim(dut, FILE_HOST)

    # Negative control: with the source delegated to S, the M-domain enable must
    # have no effect (M no longer owns it). Enable it in M and confirm silence.
    await _cfg(dut, DOM_M, 3, F_IE, 1)
    await _cfg(dut, DOM_M, 3, F_TARGET, _target(FILE_HOST, eiid=20, secure=False))
    dut.irq_sources.value = 1 << (3 - 1)
    for _ in range(4):
        await RisingEdge(dut.clk)
    # S enable is still set, so it does deliver — that proves S owns it. To prove
    # M does NOT own it, disable S and confirm the M enable cannot revive it.
    dut.irq_sources.value = 0
    await _claim(dut, FILE_HOST)
    await _cfg(dut, DOM_S, 3, F_IE, 0)
    dut.irq_sources.value = 1 << (3 - 1)
    for _ in range(4):
        await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 0, (
        "delegated source must NOT deliver via the M enable (M does not own it)"
    )
    dut.irq_sources.value = 0


@cocotb.test()
async def secure_domain_isolation(dut):
    """A confidential-domain MSI lands ONLY in the secure file; cross-world
    doorbell writes are rejected and never set a foreign EIP."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await _reset(dut)

    # Enable identity 3 in BOTH files so any leakage would be observable.
    await _eie(dut, FILE_HOST, 3, 1)
    await _eie(dut, FILE_SECURE, 3, 1)

    # 1) An untrusted-world MSI aimed at the SECURE doorbell page must be
    #    rejected (world mismatch) and set NOTHING.
    accept, reject = await _dev_msi(dut, FILE_SECURE, 3, world=0)
    assert accept == 0 and reject == 1, (
        f"host-world MSI to secure page must be rejected (a={accept} r={reject})"
    )
    await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_SECURE) == 0, "rejected MSI must not set a secure EIP"
    assert _eip_any(dut, FILE_HOST) == 0, "rejected MSI must not leak into the host file"

    # 2) A confidential-world MSI to the secure page is accepted and lands ONLY
    #    in the secure file — the host file sees nothing.
    accept, reject = await _dev_msi(dut, FILE_SECURE, 3, world=1)
    assert accept == 1 and reject == 0, (
        f"secure-world MSI to secure page must be accepted (a={accept} r={reject})"
    )
    await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_SECURE) == 1, "secure file must receive the confidential MSI"
    assert _topei_id(dut, FILE_SECURE) == 3, "secure topei should report identity 3"
    assert _eip_any(dut, FILE_HOST) == 0, "host file must NOT see the confidential MSI"
    assert _topei_id(dut, FILE_HOST) == 0, "host topei must stay 0 (no leakage)"
    await _claim(dut, FILE_SECURE)
    assert _eip_any(dut, FILE_SECURE) == 0, "secure claim clears it"

    # 3) Symmetric: a secure-world MSI aimed at the HOST page is rejected.
    accept, reject = await _dev_msi(dut, FILE_HOST, 3, world=1)
    assert accept == 0 and reject == 1, (
        f"secure-world MSI to host page must be rejected (a={accept} r={reject})"
    )
    await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_HOST) == 0, "rejected secure->host MSI sets nothing"

    # 4) APLIC path: a source delegated to S and targeting the SECURE file with
    #    secure=1 must deliver into the secure file only (the world bit flows
    #    from target.secure through the MSI to the IMSIC world gate).
    await _cfg(dut, DOM_M, 1, F_SOURCECFG, _sourcecfg(SM_LEVEL, delegate=True))
    await _cfg(dut, DOM_S, 1, F_IE, 1)
    await _cfg(dut, DOM_S, 1, F_TARGET, _target(FILE_SECURE, eiid=3, secure=True))
    dut.irq_sources.value = 1 << (1 - 1)
    for _ in range(4):
        await RisingEdge(dut.clk)
    assert _eip_any(dut, FILE_SECURE) == 1, "APLIC secure-target source must reach the secure file"
    assert _eip_any(dut, FILE_HOST) == 0, "APLIC secure MSI must not leak to the host file"
    dut.irq_sources.value = 0
    await _claim(dut, FILE_SECURE)
