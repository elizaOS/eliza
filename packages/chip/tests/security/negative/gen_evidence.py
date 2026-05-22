#!/usr/bin/env python3
"""Generate the W8 RoT-produced TeeEvidence fixture.

Emits docs/spec-db/tee-attestation-evidence.e1-rot.json per the field-mapping
table in docs/security/tee-plan/02-root-of-trust.md §6. Measurements are real
SHA-256 digests over deterministic reference stage inputs (test, non-production)
so the fixture is reproducible and the digest derivation is auditable, not
hand-typed hex. The boot measurement follows §6:
    measurements.boot = sha256(rom_ctrl_digest || H(BL1) || H(BL2))
and the freshness nonce is bound to boot_counter as required by §6 / debug-policy.

The produced fixture must pass:
    python3 scripts/check_tee_attestation_evidence.py docs/spec-db/tee-attestation-evidence.e1-rot.json

Reproduce:
    python3 tests/security/negative/gen_evidence.py
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

CHIP_ROOT = Path(__file__).resolve().parents[3]
OUT = CHIP_ROOT / "docs/spec-db/tee-attestation-evidence.e1-rot.json"

# boot_counter the §3 chain ran at; the positive-control image in run.py boots
# at rollback index 5, which is the max programmed boot-slot index -> the §6
# securityVersion.
BOOT_COUNTER = 7
SECURITY_VERSION = 5


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _raw(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def build() -> dict:
    # §3 stage inputs (deterministic references; replaced by real ROM/keymgr
    # measurements on silicon). rom_ctrl digest folded with per-stage hashes.
    rom_ctrl = _raw(b"E1-ROT rom_ctrl digest v0")
    h_bl1 = _raw(b"E1 BL1 payload reference")
    h_bl2 = _raw(b"E1 BL2 payload reference")

    nonce = hashlib.sha256(b"csrng-draw-ref" + struct.pack("<I", BOOT_COUNTER)).hexdigest()

    return {
        "kind": "keystone",
        "provider": "eliza-e1-rot",
        "hardwareVendor": "elizaos-e1",
        "platformVersion": "e1-rot-rom-v0+lc-v0",
        "securityVersion": SECURITY_VERSION,
        "measurements": {
            # boot = sha256(rom_ctrl || H(BL1) || H(BL2))  (§6)
            "boot": sha(rom_ctrl + h_bl1 + h_bl2),
            "monitor": sha(b"E1 M-mode TSM monitor reference"),
            "os": sha(b"E1 OpenSBI+monitor+kernel+initramfs reference"),
            "agent": sha(b"E1 agent image reference"),
            "policy": sha(b"E1 IOPMP source-ID policy reference"),
            "device": sha(b"E1 DeviceID cert SPKI reference"),
            "npuFirmware": sha(b"E1 NPU firmware + queue policy reference"),
        },
        "freshness": {
            # CSRNG-drawn nonce bound to boot_counter (§6, debug-policy.md §4).
            "nonce": f"csrng:{nonce}:bc{BOOT_COUNTER}",
            "timestamp": "2026-05-21T00:00:00.000Z",
            "verifier": "eliza-e1-rot-attestation",
        },
        "claims": {
            # Only the RoT may set these true, and only when the §3 chain
            # verified end-to-end on a LOCKED unit with IOPMP policy programmed.
            "secureBoot": True,
            "debugDisabled": True,
            "productionLifecycle": True,
            "ioProtected": True,
            "npuProtected": True,
            "monitorMeasured": True,
        },
        # DICE Alias cert chain (§5). Reference PEM placeholder for the
        # pre-silicon fixture; on silicon this is the real per-boot Alias cert.
        "quote": "e1-rot-dice-alias-quote-ref",
        "certificatePem": (
            "-----BEGIN CERTIFICATE-----\n"
            "REFERENCE-E1-ROT-DICE-ALIAS-CERT-CHAIN-PRE-SILICON-FIXTURE\n"
            "-----END CERTIFICATE-----\n"
        ),
        "reportData": sha(b"E1 RoT report-data reference"),
    }


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(build(), indent=2) + "\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
