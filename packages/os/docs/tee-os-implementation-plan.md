# elizaOS TEE-Native OS Implementation Plan

Date: 2026-05-21
Status: planning / requirements (no real CVM boot or hardware quote yet — fail closed)
Owner lane: OPERATING-SYSTEM (elizaOS Linux + AOSP as confidential guests)

## 0. Purpose and scope

This document is the OS-layer end-to-end plan for running elizaOS as a
**single-tenant, whole-system confidential domain**: the entire OS (elizaOS
Linux first, AOSP later), the agent runtime, the local model weights, and all
user data execute inside one hardware-isolated confidential guest. Outside the
boundary is only a tiny trusted monitor (TSM on E1, the TDX module on x86), a
hardware root of trust, and explicitly-mediated I/O.

It owns the OS half of the contracts already defined in:

- `packages/os/docs/tee-measured-boot-contract.md` — the provider-neutral
  measurement set and key-release rules.
- `packages/os/docs/tee-protected-agent-vm.md` — the macOS-feasible bridge and
  host↔guest contract.
- `packages/chip/docs/security/tee-plan/06-os-on-tee-software.md` — the chip-side
  OS-on-TEE software stack (CoVE/TSM, attestation agent, reproducible image).

It does **not** redefine the agent-side types. The canonical contract is
`packages/core/src/types/tee.ts` and `packages/agent/src/services/tee-evidence.ts`
(`TeeEvidence`, `TeeMeasurements`, `TeeClaims`, `TeeFreshness`,
`normalizeTeeEvidence`) verified by `packages/agent/src/services/tee-policy.ts`
(`evaluateTeeEvidencePolicy`). This plan specifies how OS-side software produces
the evidence those consumers already accept.

We build on **dstack** (`github.com/Dstack-TEE/dstack` + `meta-dstack`) as the
CVM packaging + attestation framework for the **cloud/x86 TDX lane available
today**, with a hardening/pinning gate before it is trusted in a high-assurance
stack. dstack is layered *on top of* an OS measured-boot/key-ladder that stands
on its own — dstack is not the root of trust.

### Status discipline (fail-closed)

Per repo `CLAUDE.md`/`AGENTS.md`: nothing here claims "confidential",
"secure boot", or "side-channel resistant" without a backing transcript. Real
dstack CVM launch, TDX/SEV quote verification, NVIDIA confidential-GPU
attestation, CoVE TVM boot, and pKVM protected-VM boot are **BLOCKED on
hardware** — that is by design, not a defect. Each work item names the gate and
the dependency that unblocks it.

---

## 1. Confidential-guest boot of elizaOS Linux

### 1.1 Two substrates, one measured-launch model

| | Cloud / x86 (TODAY) | E1 RISC-V (FUTURE) |
| --- | --- | --- |
| Isolation | Intel TDX Trust Domain (MKTME memory encryption) | CoVE/AP-TEE confidential VM (TVM) |
| Tiny TCB | TDX module (Intel-signed SEAM) | M-mode TSM / security manager (lane 01) |
| Launcher | `dstack-vmm` (QEMU/KVM + OVMF on a TDX host) | host hypervisor (Salus) requests TVM create |
| Measurement regs | MRTD + RTMR0–3 | TVM measurement register(s) folded by DICE (lane 02) |
| Image build | meta-dstack (Yocto) reproducible guest image | reproducible Buildroot/elizaOS-Linux image (lane 06 §2.2) |
| GPU/NPU | NVIDIA H100/Blackwell confidential GPU | NPU re-homed behind IOMMU as confidential I/O (lane 03) |

The OS produces the **same** `tee-measurements.json` shape on both substrates;
only the producer of `measurements.boot`/`os` and the `kind`/`provider` fields
differ (`tdx`/`dstack` vs `cove`/`eliza-riscv`). This is the whole point of the
provider-neutral contract.

### 1.2 TDX measured-launch chain (cloud, mappable to E1)

dstack/TDX gives a concrete, shipping measurement chain we adopt as the
reference. Each stage measures the next; the TDX module folds them into hardware
registers that appear in the quote:

```text
TDX module (SEAM, Intel-signed)        -> MRTD   = OVMF (virtual firmware) digest
  -> OVMF configures CPU/mem/devices   -> RTMR0  = VM config measurement
  -> OVMF loads kernel                 -> RTMR1  = kernel image
  -> initrd mounts rootfs              -> RTMR2  = initramfs
  -> rootfs runs apps (dstack-agent)   -> RTMR3  = app-compose digest + container images
```

Mapping to our normalized `TeeMeasurements`:

| `TeeMeasurements` field | TDX source | E1 CoVE source |
| --- | --- | --- |
| `boot` | MRTD (OVMF) + RTMR0 (VM config), folded | ROM+BL+OpenSBI+TSM-driver, DICE-folded |
| `os` | RTMR1 (kernel) + RTMR2 (initrd) + rootfs hash | kernel+initramfs+dtb+rootfs at TVM finalize |
| `policy` | app-compose policy fields → digest | in-domain policy blob at TVM finalize |
| `agent` | RTMR3 container/agent image digest | agent image hashed by in-domain attestation agent |
| `container` | RTMR3 app-compose digest | optional, containerized agent |
| `device` | (TDX: TD attributes / config) | IOPMP source-ID policy digest (lane 03) |
| `npuFirmware` | NVIDIA GPU attestation report (separate quote) | NPU firmware + queue-policy blob (lane 03) |

### 1.3 Recommendation: meta-dstack Yocto for the confidential profile, NOT a fork of the Tails build

The active Linux build (`packages/os/linux/elizaos/`) is a Debian live-build
(`lb`) ISO with a `secure` overlay (RAM-only home, MAC randomization, Tor,
AppArmor). It is excellent for the **USB live-key product** but is the wrong base
for a confidential guest:

- live-build is not bit-reproducible by construction (apt snapshot drift, build
  timestamps, non-deterministic squashfs ordering). Measured boot is worthless
  if the verifier cannot recompute the golden `os` digest from public sources.
- the confidential guest does not want a live desktop ISO; it wants a minimal,
  measured rootfs that boots under OVMF/`dstack-vmm` and runs the agent.

**Recommendation:** introduce a **third, separate profile** —
`ELIZAOS_PROFILE=confidential` — built from **meta-dstack (Yocto)**, not from the
Debian live-build tree. Keep the two existing profiles (`default`, `secure`)
exactly as they are for the USB-key product. The confidential profile:

1. Vendors `meta-dstack` + the upstream layers it composes (`poky`,
   `meta-virtualization`, `meta-security`, and `meta-nvidia` for the GPU lane)
   under `packages/os/linux/confidential/`, pinned by commit + a `repro-build`
   Docker context (meta-dstack ships `repro-build/repro-build.sh`).
2. Adds an elizaOS Yocto layer (`meta-elizaos`) with a recipe that bakes the
   agent container image, the in-domain attestation agent, the TEE policy blob,
   and the disk/dm-crypt tooling into the rootfs.
3. Emits a signed **image manifest** recording every component digest and the
   exact build inputs (toolchain SHAs, layer commits), so a verifier rebuilds and
   asserts digest equality offline — the "the image is the policy" model shared
   with `06-os-on-tee-software.md` §2.2.

For the **E1 RISC-V** substrate, meta-dstack does not target riscv64 and the
isolation primitive is CoVE not TDX, so the confidential profile there is built
from the chip-lane reproducible Buildroot/elizaOS-Linux image
(`06-os-on-tee-software.md` WI-3), **reusing the same image-manifest schema and
the same `tee-measurements.json` output**. One contract, two image builders.

Rationale for not unifying the image builders: TDX-on-x86 and CoVE-on-riscv64
differ in firmware (OVMF vs OpenSBI/TSM-driver), C library expectations, and
measurement-register semantics. Forcing one builder to do both would reintroduce
exactly the `if (substrate === ...)` branching the architecture rules forbid.
The shared seam is the **manifest + measurements contract**, not the build tool.

---

## 2. dstack integration on the OS side

### 2.1 What dstack provides and where it slots in (cloud/x86 lane)

dstack components and their OS-side role:

- **`dstack-vmm`** — runs on the bare-metal TDX host, parses `app-compose.json`
  (normalized from `docker-compose.yaml`), boots the CVM from the reproducible
  meta-dstack image, and allocates CPU/mem/confidential-GPU. This is the **CVM
  launcher**. It is *outside* the trust boundary (untrusted host), by design.
- **`dstack-guest-agent` (tappd)** — runs *inside* the CVM. Exposes
  `get_quote` (TDX attestation evidence) and `derive_key` over a Unix socket
  (`/var/run/dstack.sock`). Provisions per-app deterministic keys from KMS and
  encrypts local storage.
- **`dstack-kms`** — runs in its own TEE; verifies the TDX quote before releasing
  app-specific deterministic keys; enforces authorization from on-chain
  `KmsAuth`/`AppAuth` contracts.
- **`dstack-gateway`** — edge TLS termination + ACME, RA-TLS to CVMs.

CVM image contents for the elizaOS confidential profile:

```text
meta-dstack reproducible guest image (measured into MRTD/RTMR0-2)
  ├── linux kernel (RTMR1) + initramfs (RTMR2)
  ├── dstack-guest-agent / tappd            (attestation + key provisioning)
  ├── docker / container runtime
  └── app-compose.json (RTMR3) ───────────► containers:
        ├── elizaos-agent      (@elizaos/agent + app-core + local inference)
        ├── eliza-tee-bridge   (writes ELIZA_TEE_EVIDENCE_PATH/_URL, §6)
        └── (optional) model-runtime with confidential-GPU access
```

### 2.2 How `tee-measurements.json` is produced reproducibly and bound to dstack

The OS-side flow is a transform, not a re-invention:

1. **Build time (reproducible, offline-verifiable):**
   `packages/os/scripts/generate-tee-measurements.mjs` already hashes the
   `boot`/`os`/`agent`/`policy` (+ optional `device`/`container`/`npuFirmware`)
   inputs into `sha256:<hex>` and validates against the schema. For the
   confidential profile, its inputs are the **meta-dstack image manifest
   components** (kernel, initrd, rootfs) and the **app-compose digest** — the
   exact same bytes dstack will measure into RTMR1/2/3. This produces the
   **golden** `tee-measurements.json`, then signed with the release key and
   installed at `/usr/share/elizaos/tee/measurements.json`.
2. **Run time (in CVM):** the `eliza-tee-bridge` container calls tappd
   `get_quote`, parses MRTD/RTMR0–3 + TD attributes, and assembles a normalized
   `TeeEvidence` document (kind `dstack`/`tdx`). It writes it to
   `ELIZA_TEE_EVIDENCE_PATH=/run/elizaos/tee/evidence.json` (or serves
   `ELIZA_TEE_EVIDENCE_URL`). The agent's `createDstackTeeProvider`
   (`packages/agent/src/services/dstack-tee-provider.ts`) already reads exactly
   these env vars and that JSON shape.
3. **Binding check:** the bridge asserts the runtime RTMR-derived digests equal
   the signed golden `tee-measurements.json` before exposing evidence. The agent
   policy (`evaluateTeeEvidencePolicy`) then independently re-checks
   `requiredMeasurements` against the same golden values. Two independent
   comparisons (bridge + agent), neither trusting dstack alone.

The binding to dstack's report is therefore: golden manifest digests ≡ RTMR
measurements ≡ `app-compose` digest ≡ `requiredMeasurements` in the agent policy.
A tampered image or compose file changes RTMR3/`os`, the policy returns
`measurement-mismatch`, and KMS withholds the key (negative path enforced by data
unavailability).

### 2.3 dstack hardening / pinning list (MUST do before high-assurance reliance)

dstack is "Secure-by-Default" as of its Feb-2026 attestation-pipeline hardening,
but several known weakness classes must be **pinned, hardened, or replaced**
before we root anything high-value in it. The OS measured-boot/key-ladder (§1, §6)
must stand on its own so that even a fully-compromised dstack control plane
cannot release our keys without a matching golden measurement.

| Issue class | Action | OS-side enforcement |
| --- | --- | --- |
| KMS attestation bypass / DevMode (dev KMS has no security guarantees) | **Pin** to a release with mandatory QE-identity + TCB-status enforcement; **forbid** DevMode in any production policy. | Production `TeeEvidencePolicy.allowedKinds` excludes dev kinds; `requiredClaims.debugDisabled=true`, `productionLifecycle=true`. Refuse keys if quote shows DevMode. |
| Permissive DevMode auth | **Replace** dev auth with on-chain `AppAuth` code-hash allowlist; treat any non-allowlisted code hash as untrusted. | Agent policy `requiredMeasurements.agent`/`container` pinned to golden; `revokedMeasurements` for withdrawn versions. |
| Disabled / opt-in TLS verification, client-controlled PCCS URL | **Pin** to the build that removed client-controlled PCCS and made TLS verify explicit; turn verification ON. | The bridge fetches evidence only over a verified channel; no `ELIZA_TEE_EVIDENCE_URL` to an unverified endpoint in prod. |
| World-readable key material / decrypted env vars in the guest | **Harden**: env-encryption keys never persisted; secrets only in `mlock`ed pages (§3); no secrets in env dumps/logs (already a denied call in `tee-protected-agent-vm.md`). | dm-crypt user volume keyed off the unsealed key only; tmpfs `0700`; logger redaction; `MILADY_STATE_DIR` on the sealed volume. |
| Fake-quote pathways | **Pin** QE-identity verification as mandatory; reject quotes from unauthorized QE. | Independent agent-side quote shape check + nonce binding (`reportData = H(nonce‖epk)`). |
| Decompression-bomb | **Harden** image/layer fetch with size/ratio limits in the build and in any in-CVM artifact pull. | Build-time only; confidential profile pulls no untrusted archives at runtime. |
| Cert / constant-time concerns | **Track upstream**; do not depend on dstack-gateway for our crypto identity — derive the agent's signing identity from the OS key-ladder, not solely from dstack-KMS. | `RemoteSigningService` keys bound to the unsealed OS key, attested by our golden measurements. |

**Version policy (DECIDED, §8.3):** the "Pin to a release …" actions above are
satisfied by **tracking the latest dstack release** (>= the Feb-2026
Secure-by-Default baseline), not by freezing a tag, so upstream hardening fixes
land automatically. This does not weaken anything: trust is not rooted in the
dstack version, and the OS-4 `dstack-pins-check` gate re-verifies the
forbid/require/claims invariants on the live data, with every boot independently
re-checking QE-identity, TCB-status and the golden measurements — so a malicious
or downgraded release still cannot release keys.

**Principle:** dstack is the *packaging + transport + a* KMS option. The
**root of trust is the platform RoT** (TDX module / E1 RoT) plus our signed
golden measurements. The default verifier is **on-device**
(`freshness.verifier = "eliza-local-verifier"`); Eliza Cloud KMS is an optional
remote verifier for cloud-routed inference, never required for local operation.

---

## 3. Memory at the OS level

The user emphasized memory. In a single-tenant CVM the headline guarantee is
that the **untrusted host/hypervisor cannot read guest private memory** (MKTME on
TDX; MEE counter-mode AES + integrity tree on E1, lane 01). The OS must not leak
decrypted secrets *back out* of that boundary or leave them recoverable.

### 3.1 Swap — disabled, never to host-visible storage
- **No swap by default** in the confidential profile. Swapping decrypted model
  weights or user data to a host-mediated block device defeats memory encryption.
- If memory pressure forces it: `zram` only (compressed RAM, stays inside
  encrypted guest memory) — never a host-backed swap file/partition. dm-crypt the
  zram backing device with the unsealed key as defense in depth.
- Kernel cmdline: `noswap` posture enforced by systemd (`swapoff -a`, mask
  `swap.target`), measured into the policy blob.

### 3.2 mlock for secret pages
- The agent's key material, decrypted DEKs, signing keys, and the model
  key-schedule pages are `mlock`ed (or `MAP_LOCKED`/`mlockall(MCL_FUTURE)` for the
  inference process) so they are never paged out and never land in a core dump.
- Raise `RLIMIT_MEMLOCK` for the agent/inference units; `MADV_DONTDUMP` on secret
  regions; disable core dumps for those units (`LimitCORE=0`,
  `kernel.core_pattern` to a no-op inside the guest).

### 3.3 Hugepages × memory-encryption engine
- Model weights benefit from 2 MiB hugepages (fewer TLB misses, less integrity-
  tree walk overhead per access). On TDX, private memory is encrypted per-page by
  MKTME regardless of page size; hugepages reduce metadata pressure on the E1 MEE
  integrity tree (lane 01/05) and the TDX TLB.
- Use **anonymous THP / explicit hugetlbfs for the weights arena**, all in private
  (encrypted) guest memory. Never map weights from a `shared` page or a
  host-backed file (that would route them through unencrypted bounce buffers).
- Pin the weights arena (`mlock`) so the encryption engine sees a stable mapping
  and the pages are not reclaimed into page cache.

### 3.4 Page cache for decrypted model weights
- Loading weights through the normal page cache from a host-shared file would
  stage plaintext in shared memory. **Mount the model/state volume as a
  dm-crypt-over-guest-private-block device** so the page cache holds only
  decrypted-inside-the-domain pages that are themselves in encrypted guest RAM.
- Prefer `O_DIRECT` + an explicit `mlock`ed arena for the weights to bypass page
  cache entirely where the inference engine supports it; otherwise
  `posix_fadvise(DONTNEED)` after load and drop caches on unseal completion.

### 3.5 Zeroization on shutdown / panic
- On clean shutdown, unmount and `discard`/`blkdiscard` the dm-crypt volume and
  drop the unsealed key (overwrite the keyslot in RAM). On E1 this maps to the
  `scrub-pending` page state (lane 01); on TDX the TD teardown scrubs private
  pages, but the **key in guest RAM must be explicitly zeroed** before teardown.
- On panic/oops: `panic=0` with a panic notifier that zeroes the in-RAM key
  material and DEK arena before halt; never `kdump` to a host-visible target
  (kdump would write decrypted memory out). Disable kdump in the confidential
  profile.

### 3.5a Attestation-bound sealed state-volume mount hook (agent ↔ OS contract)

The dm-crypt/LUKS2 state volume in §3.4 (MILADY_STATE_DIR / ~/.milady — the
agent-session secret scope) must **not** be unlocked with a host-readable key
(dstack LUKS2 advisory GHSA-jxq2-hpw3-m5wf; agent plan §5.5). Its key is
released **only after a passing attestation** and is **bound to the measured
agent/policy/device identity**, so a tampered OS/agent derives a *different* key
and the volume simply will not decrypt — the negative path is enforced by *data
unavailability*, not a flag (agent plan §2.3 / Phase C item C3).

The attestation→key binding is owned by the **agent side**
(`packages/agent/src/services/tee-sealed-volume.ts`,
`unsealStateVolumeKey` / `sealVolumeMetadata` / `openSealedVolumeMetadata`); it
is host-agnostic and fully unit-tested in memory. The OS side owns only the
**mount hook** that calls it before mounting and refuses to mount when it
throws. Contract:

1. **Before** mounting the dm-crypt state volume (and before any agent unit that
   touches the agent-session scope starts), an early boot hook in the
   confidential guest collects in-domain `TeeEvidence` and the resolved
   production `TeeEvidencePolicy`, then calls `unsealStateVolumeKey({
   keyReleaseClient, policy, context })` for `keyId: "state-volume"`.
2. The hook **fails closed**: if `unsealStateVolumeKey` throws — because the
   boot gate already blocked secrets (`teeBootGateBlocksSecrets()`), the policy
   does not gate the required measurements (`agent`, `policy`, `device`), or the
   release decision is `trusted: false` — the hook does **not** mount the
   volume. The system boots degraded/secret-less or halts per the
   confidential-profile policy; it never falls back to a host-readable key.
3. On success the hook receives 32 bytes of released key material. Either feed
   it directly to `cryptsetup luksOpen` (as the keyslot key), or, when the LUKS
   keyslot is re-keyable independently of the attested identity, use it to
   `openSealedVolumeMetadata(sealed, keyMaterialHex)` and recover the actual
   LUKS2 passphrase from the attestation-bound envelope. Either way the **only**
   path to the passphrase is gated on a passing attestation.
4. The key/passphrase buffers stay in guest RAM only: hand them to the kernel
   keyring / `cryptsetup` and zeroize immediately (§3.2 mlock, §3.5
   zeroization). Never write them to disk, env, the host-shared window, or any
   off-domain logger.
5. The released key material is **not** persisted. On every boot the volume key
   is re-derived from a fresh attestation; rotating the measured identity (a new
   signed agent/policy/OS build) rotates the key and requires re-sealing the
   metadata envelope under the new key during a measured provisioning step.

This replaces the host-readable LUKS2 key with an attestation-released key while
keeping the security-critical binding logic in one tested place on the agent
side and the host-specific `cryptsetup` plumbing on the OS side.

### 3.6 kexec / hibernation policy
- **Hibernation disabled** (`nohibernate`, mask `hibernate.target`,
  `/sys/power/disk = [no]`). Suspend-to-disk writes the full decrypted memory
  image to host-mediated storage — categorically forbidden.
- **kexec disabled / locked down** (`CONFIG_KEXEC` off or kernel lockdown
  `kexec_load` denied). A new kernel via kexec would re-enter outside the measured
  launch and could exfiltrate memory.

### 3.7 guest_memfd / unmapped guest-private memory model
- Target the **`guest_memfd`** model: guest private memory is backed by a file
  descriptor that **cannot be mapped, read, or written by host userspace
  (QEMU/`dstack-vmm`) or even the host kernel**. Private↔shared conversion is an
  explicit `fallocate`/`PUNCH_HOLE` operation. This is the strongest available
  host-isolation primitive on TDX and is the model the E1 page-state machine
  mirrors (`private`/`shared`/`measured`/`scrub-pending`).
- The OS exposes only the minimum `shared` window for mediated I/O (virtio rings,
  bounce buffers); everything else stays `guest_memfd`-private. This ties directly
  to the chip MEE (encrypt+integrity on private pages) and TDX MKTME private
  memory — same model, two enforcers.

---

## 4. Kernel-level side-channel mitigations

Posture for a **single-tenant** CVM: there are no co-tenant guests to attack us
*inside* the domain, so the dominant threat is the **untrusted host/hypervisor +
microarchitectural leakage across the boundary**, plus a compromised in-guest
component. We harden accordingly and do not relax CPU mitigations just because we
are single-tenant.

### 4.1 CPU speculative-execution mitigations
- Keep KPTI, retbleed, MDS/TAA, MMIO-stale-data, and L1TF mitigations **enabled**.
  In a CVM the host is the adversary; do **not** pass `mitigations=off`. The ≤10%
  perf budget covers keeping these on. MKTME does not stop cache/timing side
  channels (Intel's own guidance: secret-dependent memory access is still
  vulnerable), so software-side constant-time crypto remains required.
- KASLR enabled; `randomize_kstack_offset=on`.

### 4.2 SMT / scheduler policy — no-SMT for the domain
- The E1 chip mandates **no-SMT** for confidential domains (lane 04). Reflect this
  on **both** substrates: boot the CVM with `nosmt` (or schedule it on full
  physical cores with the sibling parked). SMT sharing is a cross-thread side
  channel the single-tenant model otherwise still exposes via the host.
- Pin the inference threads to dedicated cores; disable load-balancing migration
  off the secure core set for secret-handling threads (`isolcpus`/cpuset for the
  weights/inference arena).

### 4.3 Observability lockdown to the guest
- Disable/restrict guest access to high-resolution timing and perf counters that
  sharpen side channels: `perf_event_paranoid=3`, no unprivileged `rdpmc`
  (`/sys/devices/cpu/rdpmc=0`), restrict `CAP_PERFMON`. On E1 the PMU/timer
  lockdown is enforced in HW (lane 04); on TDX, lock it in the guest kernel.
- No `/dev/mem`, `/dev/kmem`, `/proc/kcore` for the agent; `kernel.kptr_restrict=2`,
  `dmesg_restrict=1`.

### 4.4 Secure-boot lockdown + rootfs integrity
- Kernel **lockdown in confidentiality mode** (`lockdown=confidentiality`): blocks
  `kexec_load`, `/dev/mem`, unsigned module load, hibernation image, BPF that
  reads kernel memory — the same primitives §3 disables, enforced as one policy.
- **Signed kernel + IMA-appraisal** for the rootfs; `dm-verity` on the read-only
  rootfs so any rootfs tampering changes `measurements.os` and fails launch.
  Module signature enforcement on.
- **dm-crypt for persistent user data**, keyed off the **unsealed key** released
  only after attestation (§2, §6). The data volume does not mount — and
  `MILADY_STATE_DIR`/`~/.milady` is unavailable — until the quote verifies. This
  is the OS realization of the chip plan's "unseal binding" (06 §3.4).

### 4.5 Relevant research
- TEE.fail / CipherLeaks: deterministic address-tweaked memory encryption (XTS)
  leaks via ciphertext side channels — the E1 lane already chose counter-mode AES
  + integrity tree over XTS for this reason (overview §2.3). On TDX, MKTME's
  per-physical-address tweak has the analogous caveat; we mitigate at the software
  layer (constant-time crypto, no secret-dependent branching) since we cannot
  change the TDX MEE. (Cite the lane-04/05 docs and the TEE.fail line of work.)
- `guest_memfd: Unmapped Potential` (KVM Forum, Aug 2025): the unmapped-private-
  memory direction §3.7 depends on.
- Track 2025–2026 arxiv work on CVM ciphertext/interrupt/timing side channels for
  the side-channel claim matrix; do not assert resistance without lab evidence
  (lane 04 keeps those gates BLOCKED).

---

## 5. AOSP / pKVM path

**Recommendation: Linux-first, AOSP-later.** Justification:

1. **AVF/pKVM is ARM64-only.** The Android Virtualization Framework's protected-VM
   model (guest OS inside a pKVM-protected domain) has no riscv64 implementation.
   The E1 confidential-VM model is **CoVE/TSM, not AVF/pKVM**. Bridging requires
   either upstreaming a CoVE backend behind the AVF/`crosvm` API (long upstream
   goal) or running AOSP as a CoVE TVM with a thin AVF-compatible shim (interim).
2. **riscv64 ABI is bring-up, not shipping.** Android 15 CDD permits riscv64
   (RVA23) but it is not a commercial ABI; AOSP-on-E1 stays a Cuttlefish/CTS
   bring-up track behind Linux.
3. **16 KB-page divergence.** AOSP is moving to 16 KB base pages while elizaOS
   Linux bring-up uses 4 KB. TVM measurement-region granularity and the IOPMP
   source-ID policy (lane 03) must be validated at **both** page sizes before any
   AOSP confidential claim — extra gating work that should not block Linux.

OS-side AOSP requirements (when it lands), aligned with the measured-boot
contract §"AOSP Path":

- TEE policy at `/product/etc/eliza/tee-policy.json`; release measurements at
  `/product/etc/eliza/tee-measurements.json` (same schema as Linux).
- **sepolicy gating** of the protected-agent binder/vsock: a dedicated
  `eliza_agent` domain (the repo already has
  `packages/os/android/vendor/eliza/sepolicy/eliza_agent.te`) is the only domain
  permitted to reach the protected-VM management service / vsock channel; Play/
  cloud builds strip these privileged controls.
- Export **pVM quote evidence** through a privileged local service into the same
  normalized `TeeEvidence` shape (kind `tdx`/`sev-snp` on cloud Android hosts, a
  pKVM/AVF-specific kind on-device) — the agent consumes it identically.
- Reuse **AVB** for the AOSP verified-boot half; the TVM/pVM measurement binding
  sits above AVB.
- Until a CoVE-capable riscv64 KVM/crosvm path exists, AOSP confidentiality stays
  **explicitly BLOCKED** on the Cuttlefish/qemu-virt bring-up track with
  confidentiality disabled (matches `06-os-on-tee-software.md` §5).

---

## 6. The OS↔hardware and OS↔agent contracts

One provider-neutral contract across dstack/TDX/CoVE/AOSP, exactly as the
existing docs intend.

### 6.1 What the OS receives from the silicon RoT/TSM (or TDX module)

| Substrate | Launch evidence the OS receives |
| --- | --- |
| TDX (cloud) | TDX quote: MRTD, RTMR0–3, TD attributes (incl. DEBUG flag), MROWNER/config, security-version (TCB/SVN), Intel cert chain via QE; NVIDIA GPU attestation report for the confidential GPU. |
| CoVE (E1) | CoVE attestation evidence: boot/monitor/os/policy/device measurements folded by DICE, RoT cert chain, anti-rollback `securityVersion`, lifecycle/debug state (lane 02). |
| pKVM/AVF (Android) | pVM measurement + AVB state via a privileged secure-service quote. |

### 6.2 How the OS transforms it into signed `tee-measurements.json`

- **Build time:** `generate-tee-measurements.mjs` → golden
  `tee-measurements.json` (schema `tee-measurements.example.json`,
  validated by `validate-tee-measurements.mjs`), signed with the release key,
  installed at `/usr/share/elizaos/tee/measurements.json`. The release manifest's
  `tee` block (schema in `elizaos-os-release-manifest.schema.json`, currently
  **absent** in `release/beta-2026-05-16/manifest.json` — see §7) carries
  `policyDigest`, the golden `measurements`, `requiredClaims`, and `providers`.

### 6.3 Runtime evidence the OS exposes to the agent

The in-domain bridge writes the normalized `TeeEvidence`
(`packages/agent/src/services/tee-evidence.ts`) to:

- `ELIZA_TEE_EVIDENCE_PATH=/run/elizaos/tee/evidence.json`, or
- `ELIZA_TEE_EVIDENCE_URL=http://127.0.0.1:<port>/tee/evidence`
  (or the dstack socket via `DSTACK_TAPPD_URL`).

Required/known fields the OS must populate (consumed by `evaluateTeeEvidencePolicy`):

```jsonc
{
  "kind": "dstack" | "tdx" | "cove",     // substrate
  "provider": "dstack" | "eliza-riscv" | "eliza-local-verifier",
  "hardwareVendor": "intel" | "eliza",
  "platformVersion": "<tdx-module-ver | e1-rev>",
  "securityVersion": <int>,               // TCB/SVN or RoT anti-rollback counter
  "measurements": {                       // sha256:<64 hex>, equal to golden manifest
    "boot": "...", "os": "...", "policy": "...", "agent": "...",
    "container": "...", "device": "...", "npuFirmware": "..."
  },
  "freshness": { "nonce": "<verifier nonce>", "timestamp": "<RFC3339>", "verifier": "<id>" },
  "claims": {
    "debugDisabled": true, "productionLifecycle": true, "secureBoot": true,
    "memoryEncrypted": true, "ioProtected": true, "gpuProtected": true
  },
  "quote": "<base64 platform quote>",
  "certificatePem": "<RoT / QE cert chain>",
  "reportData": "sha256:<binds nonce + ephemeral pubkey>"   // anti-replay, channel binding
}
```

`reportData` MUST bind the verifier `nonce` and the RA-TLS ephemeral public key.
Key release (model weights / user-data DEK / signing keys) is allowed **only**
when the policy in `tee-measured-boot-contract.md` §"Key Release Rules" passes:
allowed kind/provider, fresh matching nonce, in-window timestamp,
`debugDisabled`+`secureBoot` (+ memory/I/O claims), `agent`+`policy` match the
golden manifest, and security-version ≥ minimum.

---

## 7. Sequenced roadmap

Effort in person-months (PM). Gates are fail-closed and name their dependency.

### 7.1 Buildable now (macOS/Linux dev — no hardware)

| WI | Work item | Deliverable | Effort | Gate |
| --- | --- | --- | --- | --- |
| OS-0 | Add a signed `tee` block to the OS release manifest (currently absent) using the existing schema + `generate-/validate-tee-measurements.mjs`; wire a `tee-measurements-check` into OS release validation. | populated `tee` block in a confidential-channel manifest + validation in `validate-release-manifest.mjs` | 0.25 | `tee-measurements-check` |
| OS-1 | `meta-elizaos` Yocto layer + `ELIZAOS_PROFILE=confidential` scaffold (vendored meta-dstack pin, repro-build context). No real image yet. | `packages/os/linux/confidential/` skeleton + image-manifest schema (shared with chip WI-3) | 1.0 | `confidential-image-manifest-check` |
| OS-2 | `eliza-tee-bridge`: tappd `get_quote` → normalized `TeeEvidence` writer; runtime-vs-golden binding assertion; mock evidence fixtures (golden + tampered). | bridge module + fixtures; reuses `dstack-tee-provider.ts` on the agent side | 1.0 | `tee-evidence-bridge-fixture-test` |
| OS-3 | Memory/side-channel **policy blob** as structured data (swap/mlock/hugepages/kexec/hibernate/nosmt/lockdown/perf settings) + checker; this is `measurements.policy`'s source. | `confidential/policy/*.json` + checker | 0.5 | `confidential-policy-check` |
| OS-4 | dstack hardening/pin manifest (§2.3) as checked data: pinned version, forbidden-DevMode, required claims, revocation list. | `confidential/dstack-pins.json` + checker | 0.5 | `dstack-pins-check` |

### 7.2 Cloud TDX lane (real dstack, real hardware — gated on a TDX host)

| WI | Work item | Effort | Gate |
| --- | --- | --- | --- |
| OS-5 | Build the reproducible confidential image via meta-dstack repro-build; assert image-hash reproducibility. | 1.5 | `confidential-image-reproducibility` (PARTIAL now / full BLOCKED on build host) |
| OS-6 | Boot the CVM under `dstack-vmm` on a 4th/5th-gen Xeon TDX host; collect a real TDX quote; verify QE identity + TCB status; bind to golden measurements. | 2.0 | `tdx-cvm-boot-smoke` (**BLOCKED** — needs TDX host) |
| OS-7 | NVIDIA H100/Blackwell confidential-GPU attestation for model weights; bind `npuFirmware`/`gpuProtected`. | 1.5 | `confidential-gpu-attest` (**BLOCKED** — needs CC-GPU host) |
| OS-8 | dm-crypt unseal end-to-end: key released by KMS only on matching quote; tampered image fails unseal (negative test). | 1.0 | `tdx-unseal-negative` (**BLOCKED** — depends OS-6) |

### 7.3 E1 silicon / sim lane (gated on chip lanes 01/02/03)

Owned by `06-os-on-tee-software.md` (CoVE/TSM bring-up, Salus harness, NPU
private-queue attest). The OS lane contributes the **same** image-manifest schema,
policy blob, and `TeeEvidence` bridge so the riscv64 path reuses everything above
the substrate. CoVE TVM boot, MEE, IOMMU/NPU isolation stay **BLOCKED** on
FPGA/silicon.

### 7.4 AOSP lane (after Linux)

pKVM/AVF protected-VM path, sepolicy gating, pVM quote export, 16 KB-page
validation. **BLOCKED** until a CoVE-capable riscv64 KVM/crosvm path exists; cloud
ARM64 TDX-equivalent (SEV-SNP) Android hosting could land sooner but is lower
priority than the Linux TDX lane.

### 7.5 Critical path

```
OS-0/OS-3/OS-4 (data+policy, now)
   └─► OS-1 (meta-elizaos profile) ─► OS-5 (repro image) ─► OS-6 (TDX boot) ─► OS-8 (unseal)
   └─► OS-2 (evidence bridge, mockable now) ──────────────► OS-6
E1 path: chip lanes 01/02/03 ─► 06 CoVE bring-up (reuses OS-1/2/3 contracts)
AOSP path: after Linux TDX lane is green; gated on riscv64 CoVE + 16KB validation
```

The **only fully-buildable-now** floor is OS-0..OS-4 (manifest `tee` block,
profile scaffold, evidence bridge with mock fixtures, policy + pin data). Real
dstack CVM launch, TDX/GPU quotes, CoVE boot, and pKVM are **BLOCKED on
hardware**, by design — each gate above names the missing dependency.

---

## 8. Open owner decisions

1. **Memory-encryption scope for v1 cloud lane:** whole-OS CVM (entire guest
   encrypted, simplest threat story) vs protected-agent subset. Whole-OS is the
   product goal and TDX supports it natively; recommend whole-OS on TDX now,
   protected-agent only as the E1 FPGA fallback (overview §5 decision 3).
2. **KMS trust anchor:** dstack-KMS (on-chain `KmsAuth`/`AppAuth`) vs Eliza Cloud
   KMS vs on-device-only sealing. Recommend **on-device-first** with Eliza Cloud
   KMS optional; never make dstack-KMS the sole anchor (§2.3 principle).
3. **dstack version pin + DevMode ban:** DECIDED — we **track the latest dstack
   release** (>= the Feb-2026 Secure-by-Default baseline) rather than freezing a
   tag, so upstream hardening lands automatically; trust stays rooted in the
   platform RoT + golden measurements and every boot re-verifies the invariants.
   DevMode remains forbidden in all production policies.
4. **Confirm Linux-first / AOSP-later sequencing** (overview §5 decision 4).
</content>
</invoke>
