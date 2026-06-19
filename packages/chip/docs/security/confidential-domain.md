# Confidential Domain Contract

Date: 2026-05-20

This contract promotes the TEE research notes into a chip-facing architecture
target. It defines the minimum hardware/software behavior needed for an Eliza
RISC-V chip to run elizaOS Linux or AOSP as a whole confidential domain.

## Security Objective

The chip must be able to launch a measured OS domain where the guest kernel,
drivers, agent runtime, NPU runtime, model data, and user data are protected
from the host, debug interfaces, unassigned devices, and DMA masters. This is a
long-term target; early prototypes may implement only the secure-vault or
protected-agent subset.

## Required Blocks

- OpenTitan-like root of trust: ROM integrity, lifecycle, OTP, key manager,
  entropy, alert handler, secure boot, and DICE derivation.
- ePMP/Smepmp on every RISC-V hart that can access protected memory.
- IOPMP/IOMMU source IDs for every DMA master, including USB, eMMC/UFS, display,
  ISP, NPU DMA, network, and debug transport.
- Confidential-domain monitor with measured launch, private/shared page state,
  domain teardown, and attestation.
- External-memory confidentiality and integrity for whole-OS TEE claims.
- Secure interrupt routing with no untrusted IRQ injection into private monitor
  state.
- Debug lifecycle policy that destroys production secrets before unlock.

## Page States

The monitor must track at least:

- `free`: not assigned to any domain.
- `private`: accessible only to the owning confidential domain.
- `shared`: explicitly shared with host or device mediation path.
- `measured`: included in launch measurement and immutable until launch.
- `device-assigned`: accessible to a measured device or DMA source ID.
- `scrub-pending`: unavailable until zeroized after teardown or failed launch.

Illegal transition examples:

- `private` to `free` without scrub.
- `private` to `device-assigned` without IOPMP policy.
- `measured` mutation after attestation digest finalization.
- host DMA into `private` memory.

## Attestation Measurements

The chip quote must be able to represent:

- ROM and lifecycle state.
- BL1/BL2/OpenSBI or equivalent firmware.
- monitor/security-manager digest.
- OS kernel, initramfs, rootfs/system image, device tree, and policy.
- agent image/container/APK digest.
- NPU firmware and queue policy digest when private inference is enabled.
- debug state, rollback/security version, and production lifecycle claim.

The normalized agent-side representation is `TeeEvidence`; provider-specific
certificates or quotes must preserve enough data to populate that shape.

## I/O Rule

Every DMA-capable block is denied by default. A device can access confidential
memory only when:

1. the device or firmware is measured or assigned by policy;
2. the monitor programs IOPMP/IOMMU source-ID permissions;
3. shared buffers are marked `shared` or `device-assigned`;
4. reset and error paths revoke access and scrub queues.

The NPU is treated as secure I/O, not a normal peripheral. Private inference
requires measured NPU firmware, private queue ownership, DMA isolation, and no
untrusted performance-counter leakage.

## Side-Channel Requirements

Initial implementation must fail closed on claims it cannot prove. Product
claims require:

- no SMT for confidential domains, or provable SMT partitioning;
- cache/TLB/BPU/prefetcher flush or partition on domain switch;
- PMU and high-resolution counter disablement or virtualization;
- constant-time boot and key code;
- key zeroization on reset, tamper, teardown, and failed health checks;
- voltage/clock/temperature/light monitoring for production physical-hardening
  claims.

## macOS-Feasible Gates

Can validate now:

- architecture docs and schema consistency;
- synthetic evidence fixtures;
- monitor/page-state model tests if implemented in TypeScript/Python;
- IOPMP policy table generation from chip manifests.

Deferred to bare-metal Linux, FPGA, or simulator hardware:

- real confidential Linux boot;
- real DMA isolation tests;
- memory encryption/integrity tests;
- NPU queue isolation;
- physical tamper and side-channel lab validation.
