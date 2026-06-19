# 06c — Android / CoVE Gap Analysis + Interim Shim Plan

Date: 2026-05-22
Status: buildable-now gap analysis. Every Android confidential claim is
**BLOCKED**; this document enumerates the gaps and the interim approach. It is
not implementation evidence.

This is the WI-8 companion to [`06-os-on-tee-software.md`](06-os-on-tee-software.md)
§5. Sequencing recommendation: **elizaOS Linux first, AOSP later.** The rationale
and the concrete gaps follow.

---

## 1. The four gaps

### 1.1 riscv64 ABI is not a shipping commercial ABI

Android 15's CDD permits the riscv64 ABI and targets the RVA23 profile, but no
device ships it commercially. AOSP-on-E1 is therefore a bring-up / CTS track
behind the Linux path, not a product surface.

### 1.2 AVF / pKVM is ARM64-only

The Android Virtualization Framework reference implementation — the "guest OS
inside a protected pKVM domain" model — does not cover riscv64. The E1
confidential-VM model is **CoVE/TSM, not AVF/pKVM**. Closing this needs either:

- **(a) upstream goal:** a CoVE backend behind the AVF / `crosvm` virtualization
  API, so AVF management surfaces drive a CoVE TVM; or
- **(b) interim:** run AOSP directly as a CoVE TVM and expose a thin
  AVF-compatible management shim. Option (b) is the interim approach; option (a)
  is the upstream target.

### 1.3 16 KB base-page divergence

AOSP is moving to 16 KB base pages while elizaOS-Linux bring-up uses 4 KB. The
TVM measurement-region granularity and the IOPMP source-ID policy must be
validated at **both** page sizes before any AOSP confidential claim — a
measurement computed at one granularity does not transfer to the other.

### 1.4 Verified boot

Reuse AVB (`docs/security/avb-a-b-ota.md`) for the AOSP verified-boot half; the
TVM-measurement binding from doc 06 §2 sits **above** AVB. AVB proves the image
is signed; the TVM measurement proves the running guest is the measured one.

## 2. Interim approach

Keep AOSP on the existing Cuttlefish / qemu-virt bring-up track
(`docs/android/cuttlefish-riscv64-bringup.md`) with confidentiality **disabled**,
explicitly BLOCKED until a CoVE-capable riscv64 KVM/crosvm path exists. The
confidential release manifest already reflects this: the Cuttlefish artifact in
`packages/os/release/confidential-2026-05-21/manifest.json` is annotated
"AOSP confidential path is BLOCKED until a CoVE-capable riscv64 KVM/crosvm path
exists; Cuttlefish bring-up only, confidentiality disabled."

## 3. Buildable-now vs BLOCKED

| Surface | Buildable now | Blocked on |
| --- | --- | --- |
| Gap analysis + interim shim plan (this doc) | YES | — |
| Cuttlefish/qemu-virt riscv64 AOSP bring-up (non-confidential) | per the Android bring-up track | — |
| AVF-compatible management shim over a CoVE TVM | NO | CoVE-capable riscv64 KVM/crosvm |
| 16 KB-page TVM measurement + IOPMP validation | NO | dual-page-size measurement harness |
| AOSP confidential boot as a CoVE TVM | BLOCKED | all of the above + lane 03 + the confidential-boot smoke (06 WI-6) |

The RTL/runtime gates remain BLOCKED. The only buildable-now deliverable here is
this gap analysis; it gates the Android confidential claim closed and names every
dependency.
