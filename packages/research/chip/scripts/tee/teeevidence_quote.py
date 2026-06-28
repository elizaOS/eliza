#!/usr/bin/env python3
"""Measured-launch chain -> TeeEvidence measurement/claim MODEL (C5).

This is the pure measurement-folding + claim-derivation model: it folds a
measured-launch chain into the measurement set and derives the claim booleans
from explicit launch conditions. The output shape is bound field-by-field to
the canonical agent type at packages/agent/src/services/tee-evidence.ts (NOT
packages/core/src/types/tee.ts; see tee-plan/07 section 0 drift correction).

It does NOT sign anything; the `quote` field is a model placeholder. The SIGNED
on-device producer is the M-mode TSM firmware fw/dice/cove_quote.c, which mirrors
this folding exactly and emits a real RoT-rooted, Ed25519-signed CoVE quote whose
canonical JSON the agent verifier (cove-quote.ts, verifyCoveQuote) accepts; the
byte-exact round-trip is gated by scripts/check_cove_quote.py. This model stays
as the readable folding reference and as the input the firmware reproduces. Only
the silicon UDS / provisioned DeviceID key ceremony remains physically BLOCKED.

Reference (read-only) for the consumed type:
  TeeEvidence.measurements: boot, os, agent, policy, device, monitor,
    npuFirmware, modelWeights, container, compose, gpuFirmware
  TeeEvidence.claims: secureBoot, debugDisabled, productionLifecycle,
    memoryEncrypted, ioProtected, npuProtected, gpuProtected
  TeeEvidence.freshness: nonce, timestamp, verifier
  TeeEvidence.reportData: sha256:<hex>  (binds H(nonce || ephemeral pubkey))
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

# Measurements the TSM-rooted launch chain always produces. npuFirmware and
# monitor are produced only on the protected-inference path; see assemble().
BASE_MEASUREMENT_ORDER = ("boot", "monitor", "os", "policy", "device", "agent")


def sha256_hex(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def extend(register: str, segment: bytes) -> str:
    """Extend-only measurement register update: new = H(prev_digest || segment)."""
    prev = register.split(":", 1)[1] if register.startswith("sha256:") else register
    return sha256_hex(bytes.fromhex(prev) + hashlib.sha256(segment).digest())


@dataclass
class LaunchChain:
    """The measured-launch inputs the RoT/TSM hashes into the quote.

    Each field is the raw image/blob bytes the corresponding measurement
    register absorbs. npu_firmware and npu_queue_policy are present only when
    private inference is enabled.
    """

    rom: bytes
    lifecycle: bytes
    bl1: bytes
    bl2: bytes
    tsm: bytes
    kernel: bytes
    initramfs: bytes
    dtb: bytes
    policy: bytes
    device_policy: bytes
    agent: bytes
    npu_firmware: bytes | None = None
    npu_queue_policy: bytes | None = None
    model_weights: bytes | None = None


@dataclass
class LaunchConditions:
    """Silicon conditions that gate each TeeEvidence claim (section 7.1).

    A claim is true only when the component that owns the condition asserts it.
    """

    secure_boot_verified: bool
    lifecycle_locked: bool
    memory_encryption_active: bool
    iopmp_programmed: bool
    npu_private_queue_owned: bool = False


@dataclass
class QuoteRequest:
    nonce: str
    ephemeral_pubkey: bytes
    timestamp: str
    verifier: str = "eliza-local-verifier"
    provider: str = "eliza-riscv"
    hardware_vendor: str = "eliza"
    platform_version: str = "e1-model-v0"
    security_version: int = 1
    extra_measurements: dict[str, str] = field(default_factory=dict)


def fold_boot_measurement(chain: LaunchChain) -> str:
    """RoT boot register: extend over rom, lifecycle, BL1, BL2 (DICE-folded)."""
    register = sha256_hex(b"")
    for segment in (chain.rom, chain.lifecycle, chain.bl1, chain.bl2):
        register = extend(register, segment)
    return register


def fold_os_measurement(chain: LaunchChain) -> str:
    """TSM OS register: kernel + initramfs + DTB at TVM finalize."""
    register = sha256_hex(b"")
    for segment in (chain.kernel, chain.initramfs, chain.dtb):
        register = extend(register, segment)
    return register


def report_data(nonce: str, ephemeral_pubkey: bytes) -> str:
    """Bind the quote to the live channel: H(nonce || ephemeral pubkey)."""
    return sha256_hex(nonce.encode("utf-8") + ephemeral_pubkey)


def assemble(
    chain: LaunchChain,
    conditions: LaunchConditions,
    request: QuoteRequest,
) -> dict[str, object]:
    npu_protected = (
        conditions.npu_private_queue_owned
        and chain.npu_firmware is not None
        and chain.npu_queue_policy is not None
    )

    measurements: dict[str, str] = {
        "boot": fold_boot_measurement(chain),
        "monitor": sha256_hex(chain.tsm),
        "os": fold_os_measurement(chain),
        "policy": sha256_hex(chain.policy),
        "device": sha256_hex(chain.device_policy),
        "agent": sha256_hex(chain.agent),
    }
    if npu_protected:
        npu_fw = chain.npu_firmware or b""
        npu_policy = chain.npu_queue_policy or b""
        measurements["npuFirmware"] = sha256_hex(npu_fw + npu_policy)
    if chain.model_weights is not None:
        measurements["modelWeights"] = sha256_hex(chain.model_weights)
    measurements.update(request.extra_measurements)

    claims: dict[str, bool] = {
        "secureBoot": conditions.secure_boot_verified,
        "debugDisabled": conditions.lifecycle_locked,
        "productionLifecycle": conditions.lifecycle_locked,
        "memoryEncrypted": conditions.memory_encryption_active,
        "ioProtected": conditions.iopmp_programmed,
        "npuProtected": npu_protected,
    }

    return {
        "kind": "cove",
        "provider": request.provider,
        "hardwareVendor": request.hardware_vendor,
        "platformVersion": request.platform_version,
        "securityVersion": request.security_version,
        "measurements": measurements,
        "freshness": {
            "nonce": request.nonce,
            "timestamp": request.timestamp,
            "verifier": request.verifier,
        },
        "claims": claims,
        "quote": "model-cove-quote-unsigned",
        "reportData": report_data(request.nonce, request.ephemeral_pubkey),
    }
