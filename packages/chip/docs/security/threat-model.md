# Threat Model — Boot, Update, Debug, Manufacturing, RMA

Status: pre-silicon specification. Not implementation evidence. This document
defines the assets, adversaries, attack surfaces, and required mitigations that
the boot, OTA, debug, and manufacturing flows must satisfy before any
"secure boot", "verified boot", "rollback protected", or "debug locked" claim
may be made (see `docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml`).

Scope domains: ROM, bootloader, recovery, OTA client, AVB chain, debug
authentication, manufacturing provisioning, RMA unlock, and signer/HSM
operations.

## 1. Assets

| ID | Asset | Confidentiality | Integrity | Availability |
|----|---|---|---|---|
| A1 | Root public-key hash (in OTP) | Public | Critical | Critical |
| A2 | Root signing private key (offline HSM) | Critical | Critical | High |
| A3 | AVB vbmeta signing key (online signer) | Critical | Critical | High |
| A4 | Vendor / OEM intermediate keys | High | Critical | High |
| A5 | Debug-authentication root key hash (OTP) | Public | Critical | Medium |
| A6 | Rollback indices (OTP monotonic counters) | Public | Critical | Critical |
| A7 | Lifecycle state fuses | Public | Critical | Critical |
| A8 | Boot ROM code (mask ROM) | Public | Critical | Critical |
| A9 | Bootloader / recovery / OTA client images | Public | Critical | High |
| A10 | User data and KeyMint key blobs | Critical | Critical | Medium |
| A11 | Per-device identity (UDID, attestation key) | High | Critical | Medium |
| A12 | Manufacturing audit log | High | Critical | High |
| A13 | Signer access credentials / HSM PINs | Critical | Critical | High |

## 2. Adversaries

| ID | Adversary | Capability | In-scope |
|----|---|---|---|
| T1 | Remote network attacker | Network-level only; can serve malicious OTA payloads on the same channel. | Yes |
| T2 | Local USB attacker | Physical USB-C access, fastboot/ADB protocol-level. | Yes |
| T3 | Storage-replacement attacker | Can swap eMMC/UFS/SD; replay old images; corrupt partitions. | Yes |
| T4 | Bus/probe attacker | Logic analyzer on SPI/eMMC/JTAG headers; no decapsulation. | Yes |
| T5 | Lost-or-stolen-device attacker | Possession; tries fastboot unlock; user-data extraction. | Yes |
| T6 | Insider at OEM / signer | Access to signer host but not HSM key material. | Yes (audit-only mitigation) |
| T7 | Compromised manufacturing line | Can attempt to over-provision, downgrade, or program forbidden lifecycle states. | Yes |
| T8 | Decap / FIB / e-beam attacker | Invasive silicon attack; OTP imaging. | Out of scope for v0 — explicit non-goal |
| T9 | Side-channel attacker (DPA, EM) | Power/EM analysis on signature verification. | Out of scope for v0 — explicit non-goal |
| T10 | Supply-chain ROM trojan | Modifies mask ROM mid-foundry. | Out of scope (mitigated only by foundry contract + ROM hash publication) |

## 3. Attack surfaces

| Surface | Domain | Exposes |
|---|---|---|
| S1 Mask ROM reset vector | ROM | A8, indirectly A1 |
| S2 SPI/eMMC boot read path | ROM / bootloader load | A9 |
| S3 vbmeta / AVB descriptor parsing | bootloader | A9, A6 |
| S4 OTA payload parser (update_engine) | OS | A9 |
| S5 fastboot / fastbootd protocol | bootloader / userspace | A6, A7, A10 |
| S6 Recovery sideload | recovery | A9 |
| S7 JTAG / SWD test port | debug | A8, A10 |
| S8 USB-C CC/PD policy engine | USB stack | indirect — denial of service, malicious source |
| S9 OTP programming interface | mfg | A1, A5, A6, A7, A11 |
| S10 Signer host / HSM API | offline / online | A2, A3, A4, A13 |
| S11 RMA unlock challenge-response | service | A5, A7, A10 |

## 4. Required Mitigations

| ID | Mitigation | Surfaces | Spec doc |
|----|---|---|---|
| M1 | Verify next-stage signature with key chained to OTP root hash (A1) before transfer of control. ROM halts on failure. | S1, S2 | boot-image-format.md |
| M2 | Reject any image whose rollback index < the OTP rollback index for that slot. | S2, S3, S4 | boot-image-format.md, avb-a-b-ota.md |
| M3 | AVB chain partition descriptors covering boot, vendor_boot, dtbo, system, vendor, product; vbmeta signed by A3. | S3 | avb-a-b-ota.md |
| M4 | Reject OTA payload with bad signature, wrong key, downgrade rollback, or corrupt metadata before any write to inactive slot. | S4 | avb-a-b-ota.md, test-plan.md |
| M5 | Two-stage OTA: download to staging, verify whole-image signature, then apply to inactive slot; mark slot unbootable on partial install. | S4 | avb-a-b-ota.md |
| M6 | Refuse OTA below configured battery threshold and on full storage. | S4 | avb-a-b-ota.md |
| M7 | fastboot flashing disabled when lifecycle = LOCKED; unlock requires user opt-in and triggers full user-data wipe + key erasure. | S5 | debug-policy.md, avb-a-b-ota.md |
| M8 | JTAG/SWD gated by lifecycle fuse + debug-auth challenge signed by key chained to A5. | S7 | debug-policy.md |
| M9 | Recovery image covered by AVB; recovery sideload requires same signature policy as OTA. | S6 | avb-a-b-ota.md |
| M10 | OTP write logic disables programming of lifecycle, root, and rollback fuses after lifecycle transition to LOCKED. | S9 | otp-fuse-map.md |
| M11 | All signing operations executed by HSM; signer host never holds plaintext private key; every signature emits an audit-log entry with operator, image hash, key id, timestamp. | S10 | key-ceremony.md |
| M12 | RMA unlock uses per-device challenge-response signed by OEM RMA key; success enters RMA lifecycle state which erases user keys and is one-way. | S5, S11 | debug-policy.md, key-ceremony.md |
| M13 | USB-C CC policy implements sink-only by default; source advertise restricted; ESD per IEC 61000-4-2 +/-8 kV contact at connector. | S8 | usb-pd-spec.md |
| M14 | Boot ROM published with cryptographic hash; foundry mask-set digest archived in release manifest. | S1 | boot-image-format.md |

## 5. Non-goals (explicit)

- No defense against decapsulation, FIB rework, or e-beam OTP imaging.
- No DPA/EM side-channel countermeasures in v0 signature verification.
- No claim of Common Criteria, FIPS 140, or GP TEE certification.
- No anti-rollback for non-AVB partitions (e.g., misc, persistent).
- No StrongBox / discrete secure element in v0 (KeyMint TEE-only is the ceiling).

## 6. Fail-closed defaults

If any required mitigation cannot be verified at boot, the platform must:

1. Halt before executing mutable firmware (no fallback to unsigned).
2. Light an unverified-boot indicator and emit a structured halt log to UART.
3. Refuse to enter any state that permits writes to user data partitions.

Any deviation from these defaults invalidates every claim in
docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml.
