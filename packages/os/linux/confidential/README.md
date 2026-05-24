# ELIZAOS_PROFILE=confidential — meta-elizaos / Yocto confidential guest

Status: **scaffold only.** The reproducible image build is **BLOCKED** on a
build host (gate `confidential-image-reproducibility`). Do not treat anything
here as a built or attested artifact.

This directory is the OS-layer confidential profile described in
`packages/os/docs/tee-os-implementation-plan.md` §1.3 / OS-1. It is **separate
from** the Tails/Debian live-build USB product under
`packages/os/linux/elizaos/` (profiles `default` and `secure`). The live-build
ISO is not bit-reproducible by construction and is the wrong base for a measured
confidential guest; this profile is built from **meta-dstack (Yocto)** instead.

## Layout

```
confidential/
  README.md                     this file
  dstack-pins.json              dstack hardening/pin-set (OS-4, plan §2.3)
  policy/
    confidential-policy.json    memory + side-channel posture (OS-3); source of measurements.policy
  cmdline.conf                  GENERATED kernel-cmdline fragment (noswap/nohibernate/nosmt/lockdown/...)
  sysctl.d/99-confidential.conf GENERATED sysctl drop-in (kptr_restrict/perf_event_paranoid/dmesg_restrict/...)
  masked-units.txt              GENERATED systemd masked-units list (swap.target/hibernate.target/kdump.service)
  meta-elizaos/                 elizaOS Yocto layer (real layer.conf + recipe); full image build BLOCKED
    conf/layer.conf                              OE layer config (BBFILE_COLLECTIONS/PATTERN/PRIORITY/...)
    recipes-elizaos/elizaos-confidential-profile/  REAL recipe: installs policy + measurements + cmdline/sysctl/masked
    recipes-elizaos/elizaos-agent/                 agent container + attestation agent recipe (BLOCKED on a build host)
```

## Policy-digest binding (OS-3 enforcement)

`measurements.policy` is the sha256 of the **canonicalized** (stable key order)
`policy/confidential-policy.json`. Regenerate it and the boot artifacts after any
policy change:

```
node packages/os/scripts/generate-tee-measurements.mjs --policy policy/confidential-policy.json ...
node packages/os/scripts/generate-confidential-artifacts.mjs
```

`check-confidential-policy.mjs` recomputes that canonical digest and asserts it
equals both manifests' `policy` digest (fail-closed on drift), and
`check-confidential-artifacts.mjs` asserts `cmdline.conf` / `sysctl.d/` /
`masked-units.txt` are exactly the enforcement form of the policy. Editing the
policy without regenerating fails both gates.

## What is buildable now (OS-0..OS-4)

- The `tee` measured-boot block in the confidential release manifest
  (`packages/os/release/confidential-2026-05-21/manifest.json`), validated by
  `packages/os/scripts/validate-release-manifest.mjs` and
  `validate-tee-measurements.mjs` (fail-closed on missing required digests).
- The policy blob (`policy/confidential-policy.json`) and the dstack pin-set
  (`dstack-pins.json`) as checked data.
- The runtime-evidence bridge with mock fixtures
  (`packages/os/scripts/tee-evidence-bridge.mjs`), which emits the normalized
  `TeeEvidence` shape the agent's `dstack-tee-provider.ts` consumes.

## What is BLOCKED (and the command that will later prove it)

| Item | Gate | Missing dependency | Proving command (once unblocked) |
| --- | --- | --- | --- |
| Reproducible image build | `confidential-image-reproducibility` | meta-dstack repro-build host | `meta-dstack/repro-build/repro-build.sh` then assert image-hash equality |
| Real CVM boot + quote | `tdx-cvm-boot-smoke` | 4th/5th-gen Xeon TDX host | `node packages/os/scripts/tee-evidence-bridge.mjs --quote-source tappd --socket /var/run/dstack.sock` |
| Confidential-GPU attest | `confidential-gpu-attest` | NVIDIA H100/Blackwell CC-GPU host | NVIDIA CC attestation report → bind `gpuFirmware` / `gpuProtected` |
| dm-crypt unseal negative | `tdx-unseal-negative` | depends on `tdx-cvm-boot-smoke` | tampered image must fail KMS key release |

The shared seam across the cloud-TDX and E1-CoVE substrates is the
**manifest + measurements contract**, not the image builder. The riscv64/E1 path
reuses this manifest schema, policy blob, and evidence bridge via the chip lane
(`packages/chip/docs/security/tee-plan/06-os-on-tee-software.md`).
