# Trusted Execution Environment Architecture and Implementation Plan

Date: 2026-05-20

This report maps current TEE research and implementation options onto the
local `packages/chip`, `packages/os`, and `packages/agent` codebase. The target
product is an Eliza agent running on elizaOS Linux or AOSP, on an eventual
Eliza RISC-V chip, with end-to-end attestation and key release. The preferred
long-term shape is a whole-OS confidential domain: the OS, agent runtime, NPU
runtime, and local model/data path execute inside the protected domain, while
only a small root of trust, monitor, and I/O mediation path remain outside it.

## Executive Recommendation

Build this in three layers, with a staged fallback path:

1. **Application first:** add a dstack-compatible TEE provider to
   `packages/agent`, because this can be validated on Intel TDX/NVIDIA
   Confidential Computing hardware before custom silicon exists.
2. **OS second:** make elizaOS Linux and AOSP emit and consume measured-boot
   evidence, then support a protected VM / confidential VM boot path for the
   agent environment.
3. **Chip third:** evolve `packages/chip` from its current secure boot, ePMP,
   IOPMP, DICE, and OpenTitan-style research plan into a CoVE-like
   whole-system confidential computing architecture.

The practical near-term architecture is **dstack inside a confidential VM** for
the agent. The best long-term architecture is **a single-tenant RISC-V
confidential system** where elizaOS itself is the trusted guest. The safest
incremental architecture is **a secure subsystem/vault for keys and policy**
plus normal Linux/AOSP execution until the whole-OS TEE is mature.

## Local Repository Baseline

### `packages/chip`

The chip package already has a security research spine that aligns with this
plan:

- `packages/chip/research/security_2026/02_analysis/tee_and_confidential_compute.md`
  covers RISC-V TEE options, ePMP/Smepmp, IOPMP, Keystone, Penglai, CoVE,
  DICE, SPDM/RATS, and KeyMint.
- `packages/chip/research/security_2026/02_analysis/side_channel_and_tamper.md`
  covers cache, branch, speculation, DPA/EM, fault injection, RowHammer, cold
  boot, OTP scrambling, active mesh, analog monitors, and v0/v1/v2 posture.
- `packages/chip/research/security_2026/03_implementation/security_path_for_e1.md`
  ranks OpenTitan-style RoT, AVB, OTBN/HMAC, dm-verity, ePMP/IOPMP, TRNG, DICE,
  and Keystone/OP-TEE as implementation items.

The package also has architecture docs for boot, memory, interrupts, IOMMU,
NPU, interconnect, and security under `packages/chip/docs/arch/`, plus
Buildroot/AOSP/Linux scaffolding and NPU runtime packages under `packages/chip/sw`
and `packages/chip/compiler/runtime`.

### `packages/os`

The OS package is the elizaOS distribution:

- Linux is a Tails-derived live USB path under `linux/variants/milady-tails/`.
- AOSP lives under `packages/os/android/`, with Cuttlefish validation, Pixel
  target support, privileged assistant/system app integration, sepolicy, init
  hooks, product overlays, and release manifests.
- The Android layer already treats `ai.elizaos.app` as the privileged assistant
  and full-control system app in AOSP builds.

This means the OS work should not start with a new distribution. It should add
measured boot evidence, protected-VM support, dstack guest images, and
attestation verification to the existing Linux and Android release paths.

### `packages/agent`

The agent package already has useful boundaries:

- `RemoteCapabilityRouterService` routes file, terminal, git, model, and plugin
  capability calls to remote endpoints.
- `remote-capability-endpoint-provider.ts` defines provider IDs, endpoint
  provisioning, and provenance/trust policy enforcement.
- `remote-capability-cloud-sandbox.ts` and `e2b-capability-router.ts` already
  support cloud and E2B-style sandbox backends.
- `SandboxManager` runs local restricted containers with no network by default,
  dropped Linux capabilities, resource limits, and controlled workspaces.
- `RemoteSigningService` and `SigningPolicyEvaluator` separate key custody,
  signing policy, replay protection, rate limits, and human approval.

These are the natural integration points for dstack and hardware attestation:
add a TEE provider, extend trust policy with measured evidence, and bind remote
capability/plugin loading and signing to attested runtime state.

## Threat Model and Product Goals

### Assets

- Agent instructions, memory, user files, and conversation state.
- Local model weights, prompts, embeddings, and tool outputs.
- Wallet keys, signing policy state, approval state, and remote signing keys.
- Device identity, attestation keys, DICE CDI chain, KeyMint keys, and rollback
  indices.
- NPU command buffers, model parameters, intermediate activations, and DMA
  buffers.

### Primary adversaries

- Malicious cloud operator, host administrator, hypervisor, or VMM.
- Compromised normal OS kernel or privileged Android service.
- Malicious peripheral or DMA-capable device.
- Network attacker attempting endpoint spoofing or quote replay.
- Physical attacker with cold-boot, voltage/clock glitch, memory bus, or
  side-channel capability.
- Supply-chain attacker attempting fake firmware, fake measurements, stale
  components, or compromised build artifacts.

### Goals

- Run the agent in an attestable confidential environment with remote key
  release.
- Bind secrets to a measured workload, measured OS image, policy version, and
  device identity.
- Support Linux and AOSP paths without forking the whole software architecture.
- Make the RISC-V chip design forward-compatible with CoVE/CoVE-IO-style
  confidential VMs.
- Treat side channels and secure I/O as first-class design requirements.

### Non-goals for the first implementation

- Claiming physical lab resistance on early prototypes.
- Claiming StrongBox-class Android security before a physically separated
  secure element/vault exists.
- Trusting dstack as the root of trust. dstack is an orchestration,
  attestation, and key-release layer on top of hardware roots.
- Assuming attestation alone proves safety. It must be paired with freshness,
  policy, supply-chain verification, key rotation, and runtime constraints.

## Current Field Findings

### dstack

dstack is a Docker-native confidential computing stack that runs containers
inside confidential VMs and exposes attestation and key derivation through
guest components such as `tappd`. The public docs describe a model where dstack
sets up the CVM, manages lifecycle and Docker containers, and exports remote
attestation evidence binding Docker image hashes, startup arguments, and
environment variables. The KMS verifies hardware attestation before releasing
deterministic application keys.

For Eliza, this is valuable because it matches the existing agent packaging
style better than SGX-style application partitioning. The agent can remain a
normal service/container while the platform adds VM-level memory protection,
quote generation, RA-TLS, deterministic app keys, and measured image policy.

Risk: dstack is still a fast-moving software trust boundary. Treat it as a
provider implementation behind an Eliza TEE abstraction, not as the only
attestation architecture. Pin versions, verify guest images reproducibly,
review KMS behavior locally, and require local policy validation before
releasing high-value secrets.

### RISC-V

RISC-V is attractive because the chip team can combine open root-of-trust IP,
custom memory/I/O isolation, and a measured software monitor. It is also less
settled than Intel TDX, AMD SEV-SNP, or Arm CCA at deployment scale.

The main RISC-V TEE choices are complementary:

- **Keystone:** mature PMP-based enclave framework with a small M-mode security
  monitor and remote attestation. Good for small trusted components.
- **Penglai:** adds scalable memory protection ideas such as sPMP, Guarded Page
  Tables, and Mountable Merkle Trees. Better fit for many enclaves or richer
  confidential workloads.
- **Salus/CoVE:** VM-centric confidential computing direction, closest to the
  desired "whole OS in TEE" model.
- **ACE-RISCV/Dorami/verified monitor work:** promising because they shrink or
  formally constrain the security monitor and reduce firmware TCB risk.
- **OpenTitan:** not a full TEE, but the best open reference for RoT, lifecycle,
  secure boot, key derivation, alerting, OTP, entropy, and escalation.

### Side-channel and TEE attack research

Recent work makes one point clear: encrypted memory and attestation are
necessary but insufficient.

- TDXRay shows that a malicious host can still extract useful signals from
  confidential VM workloads through host-observable memory/cache behavior,
  including cases against AES T-table code and LLM tokenization.
- Ahoi attacks show that TEE notification mechanisms can become a correctness
  and integrity attack surface in TDX, SEV-SNP, and SGX-like systems.
- TEE.fail extends the physical memory-bus attack story to modern DDR5 TEE
  systems, including SGX, TDX, SEV-SNP, and knock-on risk for GPU confidential
  computing when attestation or transport keys are extracted.
- Intel's 2026 TDX side-channel guidance explicitly says secret-dependent
  memory access remains vulnerable inside TDs, and discusses KeyID alias
  behavior and host-observable cache effects.
- NVIDIA's confidential GPU model relies on CPU TEE integration, SPDM, GPU
  attestation, protected PCIe/NVLink paths, and CC-On behavior that disables
  observability tools such as performance counters.

The chip plan should assume both software-observable and physical/electrical
side channels exist. The right design target is not "side channels impossible."
The target is reduced sharing, controlled observability, constant-time
software, measured I/O, physical tamper response for high-value domains, and
clear claims about what each generation defends.

## Chip Architecture Options

### Chip Option 1: Whole-System Confidential RISC-V Appliance

This is the preferred long-term target.

**Shape**

- OpenTitan-like RoT controls ROM, lifecycle, OTP, key manager, entropy, alert
  handler, secure boot, device identity, and DICE derivation.
- A minimal Root Domain Security Manager / TEE Security Manager owns
  confidential domain creation, page ownership, interrupt routing, IOPMP policy,
  and attestation.
- elizaOS Linux or AOSP boots as a single trusted domain. The guest kernel,
  drivers, agent runtime, model runtime, and NPU runtime are inside the
  protected domain.
- External DRAM is encrypted and integrity-protected with per-domain keys.
- All DMA masters sit behind deny-by-default IOPMP/IOMMU entries.
- NPU, display, storage, USB, network, and future accelerators are either
  assigned after measurement or mediated through explicit shared buffers.
- Debug is fused off in production lifecycle states. Recovery is measured,
  rollback-protected, and audit-visible.

**Strengths**

- Best match for "run the entire OS in TEE."
- Avoids SGX-style enclave partitioning and hostile-host ABI problems.
- Reduces co-tenant side channels by making the system single-tenant.
- Gives the cleanest story for local agent privacy, local models, NPU buffers,
  and end-to-end device attestation.

**Weaknesses**

- Hardest silicon path. Requires memory encryption/integrity, page ownership,
  secure interrupt routing, IOPMP integration, and a monitor that is small
  enough to trust.
- CoVE/CoVE-IO ecosystem is still maturing.
- Secure device assignment is as hard as CPU isolation.
- Physical side channels remain and must be scoped explicitly.

**Implementation**

- Specify the confidential physical memory model in
  `packages/chip/docs/arch/memory-subsystem.md` and
  `packages/chip/docs/arch/security.md`.
- Add a `packages/chip/docs/security/confidential-domain.md` contract covering
  page states: free, private, shared, measured, assigned-device, scrub-pending.
- Extend IOMMU/IOPMP docs and RTL stubs so each DMA master has a source ID and
  deny-by-default policy.
- Add a DICE/CoVE-compatible attestation evidence format that can represent
  ROM, BL1, BL2, monitor, OS image, device tree, NPU firmware, and policy.
- Add tests that prove a malicious DMA master cannot write private memory.
- Add cache/branch/TLB flush or partition requirements on domain transitions.
- Treat NPU command buffers as confidential I/O: encrypted or private memory,
  measured firmware, queue ownership checks, and no untrusted performance
  counter leakage.

### Chip Option 2: CoVE/Salus-Style Confidential VM Host

This is the best mid-term architecture if the chip needs to support both normal
and confidential worlds.

**Shape**

- Normal host firmware and a small RISC-V TEE Security Manager create trusted
  VMs.
- elizaOS Linux and AOSP can boot as trusted VMs when confidential mode is
  requested.
- dstack runs inside a trusted VM first, then later can become the normal
  packaging layer for agent containers.
- Secure I/O starts with block/network/NPU mediation through shared memory and
  moves toward CoVE-IO or TDISP-like device assignment.

**Strengths**

- Aligns with industry direction: TDX, SEV-SNP, Arm CCA, CoVE.
- Lets normal and confidential OS paths coexist.
- Easier to test under QEMU/Salus/KVM-style emulation before silicon.
- Good fit for cloud and local hardware parity.

**Weaknesses**

- Larger TCB than a tiny secure subsystem because the guest OS is trusted.
- Host-observable access patterns still matter.
- Secure I/O maturity is the gating item.
- Live migration, nested VMs, and partitioning add complexity and should be
  excluded until the basic model is proven.

**Implementation**

- Add a `packages/chip/docs/project/cove-readiness-plan.md` gate tracking
  H-extension, AIA, ePMP, IOPMP, memory ownership, attestation, and QEMU/Salus
  boot evidence.
- Prototype trusted Linux boot in QEMU/Salus or closest available RISC-V CoVE
  stack and capture transcripts under `packages/chip/docs/evidence/`.
- Define the monitor ABI and evidence format before RTL hardening.
- Make "TVM with only virtio-block/virtio-net shared buffers" the first secure
  I/O milestone.
- Add NPU passthrough only after IOPMP, queue ownership, and reset isolation are
  verified.

### Chip Option 3: Secure Vault + Normal OS

This is the safest incremental architecture and should ship first if whole-OS
confidential computing is not ready.

**Shape**

- An OpenTitan-like secure subsystem stores device identity, key ladder,
  attestation keys, rollback counters, signing keys, and policy state.
- Linux/AOSP run normally, with KeyMint/secure services backed by the vault or
  a Keystone/OP-TEE-like TEE.
- The agent can run in a normal OS process or restricted container, but high-
  value operations such as key release, wallet signing, model decryption, and
  policy changes require vault-mediated authorization.

**Strengths**

- Much smaller trusted domain.
- Useful even if CoVE and memory encryption slip.
- Directly improves secure boot, Android KeyMint, wallet signing, encrypted
  model storage, recovery, and lifecycle control.
- Strong fallback if physical side-channel claims for whole-OS TEE are not yet
  defensible.

**Weaknesses**

- Does not protect all agent memory from a compromised OS.
- Does not satisfy the ideal "entire OS in TEE" goal.
- More application design work is required because secrets and policy must be
  explicitly kept out of the normal world.

**Implementation**

- Integrate OpenTitan-style `rom_ctrl`, `otp_ctrl`, `lc_ctrl`, `keymgr`,
  `entropy_src`, `csrng`, `edn`, `hmac`, `aes`, and alert handling per existing
  chip research recommendations.
- Add an RPC protocol for key release, signing, quote generation, monotonic
  counters, and policy sealing.
- Wire Android KeyMint and Linux agent signing through this service.
- Require DICE-derived keys for agent secrets and model decryption.

## OS Architecture Options

### OS Option 1: Whole elizaOS Linux/AOSP in a Confidential VM

This is the preferred OS target when hardware supports it.

**Shape**

- Boot ROM measures BL1/BL2.
- BL2 verifies AVB/dm-verity and measures kernel, initramfs, device tree,
  vendor image, policy, and agent image.
- The TEE Security Manager launches Linux or AOSP as a protected guest.
- The guest obtains an attestation report including boot measurements, OS
  policy, agent container digest, and hardware identity.
- The agent obtains secrets only after local or remote verification.

**Strengths**

- Best privacy story for the full OS.
- Works for Linux live USB-style elizaOS and AOSP if the protected guest ABI is
  stable.
- Minimizes code changes to the agent.

**Weaknesses**

- Requires confidential VM hardware and secure I/O.
- Guest kernel and drivers become trusted code.
- OS updates must preserve reproducible measurement and attestation policy.

**Implementation**

- Add a measured image manifest to `packages/os/release/` that records kernel,
  initramfs, rootfs, app, policy, and dstack guest digests.
- Add Linux build hooks to install a dstack guest agent / TEE provider service.
- Add AOSP product hooks under `packages/os/android/vendor/eliza/` for
  attestation service, protected-VM policy, and privileged binder permissions.
- Add release validation that refuses to publish if measurement manifests,
  signatures, rollback indices, and dm-verity evidence are missing.

### OS Option 2: Protected Agent VM or Confidential Container Lane

This is the practical near-term OS architecture.

**Shape**

- elizaOS host boots normally with secure boot and dm-verity.
- The agent runs inside a protected VM/CVM, managed by dstack or a
  Confidential Containers/Kata-style runtime.
- The host can provide display, network, storage, and device services, but the
  agent's secrets are released only to the protected guest.
- The agent talks to the host through a narrow capability channel.

**Strengths**

- Deployable before whole-OS TEE hardware.
- Aligns with dstack's Docker Compose model.
- Fits the existing `RemoteCapabilityRouterService` and sandbox manager.
- Lets Linux and AOSP share one agent TEE contract.

**Weaknesses**

- Host OS can still observe metadata, scheduling, UI events, and I/O patterns.
- Device access requires mediation.
- Some agent workflows may need refactoring to keep secrets inside the guest.

**Implementation**

- Add `packages/os/docs/tee-protected-agent-vm.md`.
- Package a dstack-compatible guest image for Linux.
- For AOSP, use AVF/pKVM where available for a protected Linux guest carrying
  the agent, or use a privileged service that brokers to a protected VM.
- Add a vsock/Unix-socket capability bridge with strict method policy.
- Bind plugin loading and remote signing to quote verification.

### OS Option 3: Android AVF/pKVM + Secure Service Hybrid

This is the best AOSP-specific option.

**Shape**

- AOSP remains the primary UI/control OS.
- pKVM/AVF hosts protected VMs for the agent, secure inference, or sensitive
  services.
- KeyMint, identity, signing, and device policy are backed by OP-TEE/Keystone
  or the secure vault.
- The privileged Eliza assistant app invokes the protected agent through
  binder/vsock bridges.

**Strengths**

- Matches Android's current protected-VM direction.
- Lets the system app keep deep AOSP integration while secrets remain in a
  protected guest or secure service.
- More realistic for phones than running every Android component as a
  confidential guest on day one.

**Weaknesses**

- Android protected VM support depends on SoC, kernel, and virtualization stack.
- Shared-memory and virtio assumptions must be audited carefully.
- UX-heavy flows can leak metadata through the host UI path.

**Implementation**

- Add an AVF capability and device-support matrix to
  `packages/os/android/installer/manifests/`.
- Add a protected-agent service to the AOSP vendor tree, with sepolicy scoped
  to binder/vsock access and no broad filesystem access.
- Include pVM quote evidence in the AOSP boot validator.
- Keep Play/cloud builds stripped of privileged pVM/system-control components.

## Application Architecture Options

### Application Option 1: dstack-First Agent Runtime

This is the recommended first implementation.

**Shape**

- The agent is packaged as one or more Docker containers.
- dstack launches the containers inside a CVM.
- `tappd`/guest agent provides attestation reports, app-bound keys, and
  certificates.
- Eliza Cloud or local verifier releases secrets only when measurements match
  approved OS image, agent image, startup args, environment policy, and hardware
  quote.

**Strengths**

- Fastest path to a working E2E TEE demo.
- No SGX-style code partitioning.
- Works with TDX and NVIDIA confidential GPU infrastructure before Eliza
  silicon exists.
- Good match for AI agent workloads and Docker-native deployment.

**Weaknesses**

- Depends on dstack maturity and correct KMS policy.
- TCB includes guest OS, Docker runtime, dstack guest components, and agent
  dependencies.
- Side-channel leakage from tokenization, model access, and secret-dependent
  behavior remains.

**Implementation**

- Add a `tee` provider type to `RemoteCapabilityEndpointProviderId`, with
  initial provider IDs `dstack`, `dstack-cloud`, and `cvm-direct`.
- Define `TeeEvidence`, `TeeMeasurement`, `TeeProvider`, and
  `KeyReleaseClient` types in `packages/agent/src/services/`.
- Extend remote endpoint trust policy to require approved evidence before
  syncing remote plugin modules.
- Add a dstack provider that reads attestation from the dstack/tappd socket and
  exposes it through capability metadata.
- Add configuration:
  - `ELIZA_TEE_PROVIDER=dstack`
  - `ELIZA_TEE_REQUIRED=true`
  - `ELIZA_TEE_POLICY_PATH=...`
  - `ELIZA_TEE_KMS_URL=...`
  - `ELIZA_TEE_EXPECTED_IMAGE_DIGEST=...`
- Require remote signing keys to be sealed to the TEE evidence or held outside
  the CVM behind an attestation-gated signer.

### Application Option 2: Native Eliza TEE Provider Abstraction

This is the durable architecture that prevents lock-in.

**Shape**

- The agent does not depend directly on dstack APIs.
- A provider interface normalizes dstack, Nitro, TDX, SEV-SNP, CoVE, Keystone,
  OP-TEE, and future Eliza chip evidence.
- Capability routing, plugin provenance, model loading, and signing policy all
  consume normalized evidence.

**Strengths**

- Makes dstack replaceable or augmentable.
- Lets cloud, phone, and custom chip deployments share one policy layer.
- Keeps attestation verification close to existing capability trust policy.

**Weaknesses**

- Requires careful evidence normalization so weak providers do not look as
  strong as strong providers.
- More initial API design.

**Implementation**

- Add normalized fields:
  - `tee.kind`: `tdx`, `sev-snp`, `nitro`, `cove`, `keystone`, `optee`,
    `eliza-vault`, `none`.
  - `tee.hardwareVendor`, `tee.platformVersion`, `tee.securityVersion`.
  - `measurements.boot`, `measurements.os`, `measurements.agent`,
    `measurements.policy`, `measurements.device`.
  - `freshness.nonce`, `freshness.timestamp`, `freshness.verifier`.
  - `claims.debugDisabled`, `claims.productionLifecycle`,
    `claims.secureBoot`, `claims.memoryEncrypted`, `claims.ioProtected`,
    `claims.gpuProtected`, `claims.npuProtected`.
- Add policy that distinguishes "secret release allowed", "plugin sync
  allowed", "signing allowed", and "high-value signing allowed."
- Add tests using fixed quote fixtures and negative cases for stale nonce,
  debug mode, wrong image digest, wrong policy digest, and missing device
  claims.

### Application Option 3: Split Agent with TEE KMS/Signing Core

This is the safest fallback if full agent execution in a TEE is too heavy.

**Shape**

- The main agent can run in normal Linux/AOSP.
- A small TEE service holds wallet keys, model decryption keys, session keys,
  and policy state.
- The main agent requests decrypt/sign/derive operations through a narrow API.
- The TEE service refuses operations unless the caller, OS, user confirmation,
  and policy state are valid.

**Strengths**

- Small TCB.
- Directly improves the highest-risk assets.
- Can use Keystone, OP-TEE, Nitro Enclave, or secure vault.
- Easier to harden against side channels than a full agent runtime.

**Weaknesses**

- Does not protect prompt context or agent memory from a compromised OS.
- Requires explicit data-flow discipline.
- More code-level partitioning work.

**Implementation**

- Extend `RemoteSigningService` so signer backends can be attested TEE backends.
- Add `TeeSignerBackend` with quote-bound request signing.
- Add model/key decryption service with sealed-key policy.
- Add audit log entries for evidence digest, policy digest, and quote nonce on
  each high-value operation.

## Recommended End-to-End Flows

### Flow A: dstack on Cloud TDX/NVIDIA CC

1. Build an agent container image and generate SBOM/provenance.
2. Register image digest, compose hash, OS image hash, policy hash, and expected
   hardware class with the verifier/KMS.
3. Launch dstack CVM on Intel TDX, with NVIDIA H100/Blackwell confidential GPU
   path when GPU inference is required.
4. Agent calls dstack/tappd to obtain quote and RA-TLS certificate.
5. Eliza verifier checks hardware quote, runtime measurements, policy digest,
   freshness nonce, and debug/CC mode.
6. KMS releases app-bound keys.
7. `RemoteCapabilityRouterService` syncs only plugins whose provenance and TEE
   policy are valid.
8. `RemoteSigningService` signs only after policy and TEE evidence pass.

### Flow B: elizaOS Linux on Eliza RISC-V Chip

1. OpenTitan-like RoT verifies ROM integrity, lifecycle state, OTP, rollback,
   entropy health, and BL1 signature.
2. BL1/BL2 verify Linux image, initramfs, rootfs, device tree, dstack/agent
   image, and policy.
3. TEE Security Manager launches Linux as a whole confidential domain or
   launches a protected agent VM.
4. IOPMP denies DMA to private memory by default.
5. NPU queues and model buffers are private or explicitly shared with measured
   NPU firmware.
6. Agent requests a device quote covering boot, OS, agent, policy, NPU firmware,
   and lifecycle.
7. Local or remote KMS releases keys.

### Flow C: AOSP on Eliza RISC-V Chip or Supported Android Device

1. AVB verifies boot/system/vendor/product images with dm-verity.
2. AOSP privileged assistant app starts a protected agent VM through AVF/pKVM or
   the Eliza protected VM service.
3. KeyMint/secure vault provides device keys and app attestation.
4. The protected agent VM exposes a capability endpoint to the system app.
5. Binder/vsock policy allows only approved capability calls.
6. Quote evidence is included in boot validation and release manifests.

## Implementation Plan

### Phase 0: Evidence Contracts

Deliverables:

- `packages/agent/src/services/tee-evidence.ts`
- `packages/agent/src/services/tee-policy.ts`
- `packages/os/docs/tee-measured-boot-contract.md`
- `packages/chip/docs/security/confidential-domain.md`
- Fixed quote/evidence fixtures for tests.

Gates:

- Evidence must include freshness nonce, measurement digests, provider kind,
  debug state, lifecycle state, and policy digest.
- Policy evaluation must fail closed on unknown provider, missing nonce, stale
  timestamp, debug/dev mode, wrong digest, or unknown security version.

### Phase 1: dstack Agent Prototype

Deliverables:

- dstack provider in `packages/agent`.
- Agent container/compose profile for dstack.
- KMS/verifier client for quote validation and key release.
- Remote capability trust policy requiring TEE evidence.
- Signing backend that can seal or gate keys by TEE evidence.

Gates:

- Run a local mocked evidence test suite.
- Run a real dstack deployment on TDX-capable infrastructure.
- Verify that wrong image digest, wrong startup args, and dev/debug mode block
  secret release.

### Phase 2: OS Protected Agent Lane

Deliverables:

- Linux image hook that installs dstack/protected-agent guest components.
- AOSP pVM/protected-agent design doc and sepolicy plan.
- Release manifest fields for TEE measurements.
- Boot validator checks for measured artifacts.

Gates:

- Linux release build emits measurement manifest and quote policy.
- AOSP Cuttlefish/AVF path validates protected-agent service where available.
- Host-to-agent bridge is covered by method allowlists and audit logging.

### Phase 3: Chip RoT and Monitor Foundation

Deliverables:

- OpenTitan-style RoT integration plan moved from research into chip docs.
- ePMP/Smepmp and IOPMP hardware contracts.
- DICE derivation and attestation format.
- Synthetic OTP/fuse model for simulator evidence.
- Secure monitor ABI draft.

Gates:

- Secure boot transcript covers ROM to BL2 to OS policy.
- IOPMP test proves malicious DMA cannot write protected memory.
- Debug lifecycle state blocks production key release.

### Phase 4: Whole-OS Confidential Domain

Deliverables:

- Confidential domain memory model and page-state transition tests.
- Guest-private/shared memory ABI.
- Confidential Linux boot in simulator or FPGA-equivalent environment.
- NPU private buffer and measured firmware path.

Gates:

- Guest OS quote binds kernel, initramfs, rootfs, device tree, policy, agent,
  and NPU firmware.
- Domain teardown scrubs private memory and invalidates keys.
- Performance counters and debug access are disabled or partitioned in
  confidential mode.

### Phase 5: Side-Channel and Physical Hardening

Deliverables:

- Side-channel claim matrix for v0/v1/v2.
- Constant-time cryptography audit for TEE code.
- Cache/TLB/BPU flush or partition hooks on domain transition.
- PMU and high-resolution timer policy.
- Voltage/clock/temp/light sensor and escalation plan for production node.
- Memory encryption and integrity design.

Gates:

- No secret-dependent table lookup in crypto paths.
- No TEE secrets in logs, environment dumps, plugin manifests, or crash traces.
- Simulated tamper/glitch paths force key zeroization or fail-closed state.

### Phase 6: Productization and Operations

Deliverables:

- Verifier service with policy versioning and key rotation.
- Quote transparency log or evidence ledger for releases.
- On-device and cloud KMS separation.
- Incident response process for compromised hardware generation or dstack KMS
  vulnerability.

Gates:

- Emergency revoke can block a bad OS image, agent image, dstack guest image,
  GPU firmware version, chip security version, or policy version.
- Rollback tests prove old vulnerable images cannot regain secret access.

## Package-Specific Work Items

### `packages/agent`

- Add TEE evidence and policy types.
- Add dstack provider.
- Add verifier/KMS client.
- Extend remote endpoint trust policy with `requireTeeEvidence`,
  `allowedTeeKinds`, `allowedMeasurementDigests`, `minSecurityVersion`, and
  `requireDebugDisabled`.
- Bind plugin sync to TEE policy.
- Add `TeeSignerBackend` and evidence-aware audit log fields.
- Add tests for policy failure modes.

### `packages/os`

- Add measured boot and protected-agent docs.
- Add Linux build hooks for dstack guest/protected-agent service.
- Add AOSP protected-agent service, sepolicy, init, and product overlays.
- Add release manifest schema fields for TEE measurements and policy digests.
- Add installer/device support matrix for AVF/pKVM or equivalent protected VM
  availability.

### `packages/chip`

- Promote existing research notes into architecture contracts.
- Add confidential-domain memory contract.
- Add IOPMP source-ID map for every DMA master, including NPU DMA.
- Add DICE/attestation evidence schema.
- Add secure monitor ABI.
- Add simulator gates for secure boot, rollback, DMA isolation, and debug
  lifecycle policy.
- Add NPU confidential I/O requirements to NPU docs.

## Side-Channel Mitigation Checklist

Use this as a design gate, not as optional polish.

- Disable SMT for sensitive domains, or do not implement SMT.
- Partition or flush L1/L2/LLC, TLB, BPU, return predictors, and prefetcher
  state on domain switch.
- Disable or virtualize PMU/performance counters in confidential mode.
- Reduce high-resolution timers exposed to untrusted domains.
- Use constant-time cryptography and no secret-dependent table lookups.
- Avoid secret-dependent model/tokenizer access where feasible; pad or batch
  sensitive inference paths when the threat model requires it.
- Prefer local SRAM/scratchpad for root secrets and key schedules.
- Encrypt and integrity-protect external DRAM for whole-OS TEE claims.
- Bind DMA to IOPMP/IOMMU source IDs and deny by default.
- Require measured firmware and reset isolation for NPU/GPU/device assignment.
- Zeroize keys on reset, tamper, failed health checks, lifecycle transitions,
  and domain teardown.
- Add voltage, clock, temperature, and light/glitch detection for production
  silicon claims.
- Keep debug unlock auditable, lifecycle-gated, and destructive for production
  secrets.

## Promising but Unproven Directions

- **ACE-RISCV / formally verified monitors:** promising because the monitor is
  the highest-leverage TCB component. Track this for a future CoVE-compatible
  monitor once the current spec and implementation stabilize.
- **Dorami-style monitor/firmware separation:** important because M-mode
  firmware can become too large to trust. Adopt the principle even before the
  exact implementation is chosen.
- **Penglai scalable memory primitives:** useful if Keystone/PMP slot limits
  become a bottleneck or if many concurrent compartments are required.
- **CHERIoT/CHERI for secure MCU or KeyMint TA:** attractive for memory safety
  in the secure subsystem, but not yet practical for the main Android/Linux ABI.
- **Oblivious or leakage-aware LLM inference:** early but important. TDXRay-like
  prompt inference means confidential AI must consider tokenizer and memory
  access patterns, not only encrypted RAM.
- **TEE plus transparency/governance:** dstack's decentralized KMS direction is
  useful as a pattern, but Eliza should keep a provider-neutral verifier and
  revocation layer.

## Decision Matrix

| Layer | Option | Security | Performance | Maturity | Fit |
|---|---|---:|---:|---:|---|
| Chip | Whole-system confidential appliance | High | Medium | Low | Best long-term |
| Chip | CoVE/Salus-style confidential VM host | High | Medium | Medium-low | Best mid-term |
| Chip | Secure vault + normal OS | Medium | High | Medium-high | Best incremental |
| OS | Whole OS in confidential VM | High | Medium | Medium-low | Preferred |
| OS | Protected agent VM/container lane | Medium-high | Medium | Medium | First product path |
| OS | AOSP AVF/pKVM hybrid | Medium-high | Medium | Medium | Best Android path |
| App | dstack-first agent runtime | Medium-high | Medium | Medium | First E2E demo |
| App | Native TEE provider abstraction | High | High | Medium | Durable platform |
| App | Split TEE KMS/signing core | Medium | High | High | Safe fallback |

## Suggested Order of Work

1. Implement the agent TEE provider abstraction and dstack provider.
2. Add quote fixtures and policy tests.
3. Build a dstack deployment of the agent on TDX and verify key release.
4. Add Linux measured image manifests and protected-agent service packaging.
5. Add AOSP protected-agent/AVF design and device support detection.
6. Convert chip research into versioned architecture contracts.
7. Implement and test IOPMP source-ID isolation for DMA masters.
8. Prototype CoVE/Salus-style trusted Linux boot in simulation.
9. Add NPU confidential I/O contracts and tests.
10. Add side-channel hardening gates and claim matrices before making product
    claims.

## Implementation Status - 2026-05-20

Implemented on macOS:

- Agent TEE evidence normalization in
  `packages/agent/src/services/tee-evidence.ts`.
- Agent TEE policy evaluation in `packages/agent/src/services/tee-policy.ts`,
  including provider allowlists, measurement checks, freshness nonce/timestamp,
  security-version minimums, revoked measurements, revoked security versions,
  and required claims.
- dstack-compatible evidence collection in
  `packages/agent/src/services/dstack-tee-provider.ts` from inline JSON, HTTP,
  or a configured evidence file.
- Remote capability endpoint TEE policy enforcement in
  `packages/agent/src/services/remote-capability-endpoint-provider.ts`, so a
  trusted endpoint can fail closed before remote plugin sync.
- TEE-backed remote capability endpoint provisioning through
  `teeRemoteCapabilityEndpointProvider`, which collects endpoint evidence and
  attaches it to provisioning metadata before policy evaluation and plugin sync.
- dstack-style agent deployment manifest in
  `packages/agent/tee/dstack-agent-deployment.example.json`, checked by
  `packages/agent/scripts/validate-tee-deployment.mjs`, binding image digest,
  compose digest, policy digest, KMS freshness, required claims, and secret
  scopes. The validator can also cross-check the deployment against the TEE
  revocation manifest so revoked measurements cannot be shipped.
- TEE-gated signing backend in
  `packages/agent/src/services/tee-signer-backend.ts`, so high-value signing can
  refuse to call the underlying signer unless evidence satisfies policy.
- Local key-release/verifier client in
  `packages/agent/src/services/tee-key-release.ts`, deriving app keys only after
  TEE policy accepts measured evidence, plus an HTTP verifier/KMS client for the
  remote key-release path.
- OS release-manifest to agent-policy bridge in
  `packages/agent/src/services/tee-release-policy.ts`, so release measurements
  become the exact required measurements consumed by plugin sync, signing, and
  key release.
- Runtime TEE policy resolver in
  `packages/agent/src/services/tee-runtime-config.ts`, supporting explicit
  policy JSON/path, OS release manifest JSON/path, freshness nonce, max age, and
  fail-closed `ELIZA_TEE_REQUIRED=true`.
- TEE revocation manifest support in
  `packages/agent/src/services/tee-revocation.ts`, with runtime loading through
  `ELIZA_TEE_REVOCATIONS_JSON` or `ELIZA_TEE_REVOCATIONS_PATH`. The example
  `packages/agent/tee/revocations.example.json` is checked by
  `packages/agent/scripts/validate-tee-revocations.mjs` and operationalizes
  emergency blocking for compromised agent, OS, policy, container, or security
  version measurements.
- Local TEE smoke experiment in `packages/agent/scripts/tee-local-smoke.ts`;
  the run writes `evidence/tee/local-tee-smoke-2026-05-20.json` with accepted
  evidence, rejected evidence, local key release, and mock HTTP verifier/KMS key
  release. The evidence file stores only derived-key digests, not key material.
- Full local cross-layer harness in `packages/agent/scripts/tee-full-stack-local.ts`;
  the run writes `evidence/tee/full-stack-local-2026-05-20.json` after creating
  OS measurement inputs, deriving agent policy from an OS release manifest,
  checking accepted/rejected evidence, exercising HTTP key release, and
  validating chip attestation evidence through the agent policy evaluator. It
  also proves revocation rejects otherwise valid evidence.
- Aggregate local TEE stack gate in
  `packages/scripts/validate-tee-local-stack.mjs`; the run writes
  `evidence/tee/local-stack-validation-2026-05-20.json` with all macOS-feasible
  checks and the explicit bare-metal gates still deferred.
- OS measured-boot contract docs in
  `packages/os/docs/tee-measured-boot-contract.md` and protected-agent VM docs
  in `packages/os/docs/tee-protected-agent-vm.md`.
- OS release manifest TEE validation in `packages/os/scripts/os-release-lib.mjs`
  and `packages/os/release/schema/elizaos-os-release-manifest.schema.json`.
- OS TEE measurement generator in
  `packages/os/scripts/generate-tee-measurements.mjs`, hashing boot, OS, agent,
  policy, container, device, and NPU firmware inputs into release measurements.
- OS TEE measurement validator in
  `packages/os/scripts/validate-tee-measurements.mjs`, with example fixture
  `packages/os/release/schema/tee-measurements.example.json`.
- Chip confidential-domain contract in
  `packages/chip/docs/security/confidential-domain.md`, machine-readable spec
  in `packages/chip/docs/spec-db/tee-confidential-domain-contract.json`, and
  checker in `packages/chip/scripts/check_tee_confidential_domain_contract.py`.
- Chip IOPMP source-ID policy in
  `packages/chip/docs/spec-db/tee-iopmp-source-id-map.json`, checked by
  `packages/chip/scripts/check_tee_iopmp_policy.py`.
- Chip confidential-domain page-state transition policy in
  `packages/chip/docs/spec-db/tee-page-state-transitions.json`, checked by
  `packages/chip/scripts/check_tee_page_state_policy.py`.
- Chip attestation evidence fixture in
  `packages/chip/docs/spec-db/tee-attestation-evidence.example.json`, checked by
  `packages/chip/scripts/check_tee_attestation_evidence.py` against the same
  normalized evidence shape consumed by the agent.
- Chip side-channel claim matrix in
  `packages/chip/docs/spec-db/tee-side-channel-claim-matrix.json`, checked by
  `packages/chip/scripts/check_tee_side_channel_claims.py`.

Validation run on macOS:

- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/services/tee-policy.test.ts packages/agent/src/services/dstack-tee-provider.test.ts packages/agent/src/services/remote-capability-tee-policy.test.ts --coverage.enabled=false`
- `bun run --cwd packages/agent typecheck`
- `bunx @biomejs/biome check ...` over the new/changed agent files
- `node --test packages/os/scripts/__tests__/os-release-scripts.test.mjs`
- `node packages/os/scripts/validate-tee-measurements.mjs`
- `node -e "JSON.parse(...elizaos-os-release-manifest.schema.json...)"`
- `python3 packages/chip/scripts/check_tee_confidential_domain_contract.py`
- `python3 packages/chip/scripts/check_tee_iopmp_policy.py`
- `python3 packages/chip/scripts/check_tee_page_state_policy.py`
- `python3 packages/chip/scripts/check_tee_attestation_evidence.py`
- `python3 packages/chip/scripts/check_tee_side_channel_claims.py`
- `bun run packages/agent/scripts/tee-local-smoke.ts`
- `bun run packages/agent/scripts/tee-full-stack-local.ts`
- `node packages/agent/scripts/validate-tee-deployment.mjs packages/agent/tee/dstack-agent-deployment.example.json packages/agent/tee/revocations.example.json`
- `node packages/agent/scripts/validate-tee-revocations.mjs`
- `node packages/scripts/validate-tee-local-stack.mjs`

Still deferred because this Mac cannot provide the required hardware or
bare-metal environment:

- real dstack CVM launch on Intel TDX or AMD SEV-SNP;
- real NVIDIA confidential GPU attestation;
- Android AVF/pKVM protected VM quote collection;
- RISC-V CoVE/Salus confidential Linux boot;
- IOPMP/IOMMU DMA isolation on Eliza chip RTL or FPGA;
- memory encryption/integrity validation;
- NPU private queue isolation;
- physical side-channel and tamper validation.

## References

- dstack overview: https://docs.phala.com/dstack/overview/
- dstack project: https://github.com/Dstack-TEE/dstack
- dstack site: https://dstack.org/
- dstack audit: https://reports.zksecurity.xyz/reports/phala-dstack
- dstack paper: https://arxiv.org/abs/2509.11555
- Intel TDX documentation: https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/documentation.html
- Intel TDX side-channel guidance: https://www.intel.com/content/www/us/en/developer/articles/technical/software-security-guidance/best-practices/mktme-side-channel-impact-on-intel-tdx.html
- Google TDXRay: https://research.google/pubs/tdxray-microarchitectural-side-channel-analysis-of-intel-tdx-for-real-world-workloads/
- TEE.fail: https://tee.fail/
- Ahoi attacks: https://ahoi-attacks.github.io/
- NVIDIA H100 confidential computing: https://developer.nvidia.com/blog/confidential-computing-on-h100-gpus-for-secure-and-trustworthy-ai/
- NVIDIA attestation SDK: https://docs.nvidia.com/attestation/attestation-client-tools-sdk/latest/gpu_and_switch_attestation.html
- Android AVF architecture: https://source.android.com/docs/core/virtualization/architecture
- AWS Nitro Enclaves: https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html
- Confidential Containers design: https://confidentialcontainers.org/docs/architecture/design-overview/
- Confidential Containers policies: https://confidentialcontainers.org/docs/attestation/policies/
- Keystone docs: https://docs.keystone-enclave.org/en/latest/
- Keystone attestation: https://docs.keystone-enclave.org/en/latest/Keystone-Applications/Attestation.html
- Keystone paper: https://arxiv.org/abs/1907.10119
- Penglai: https://penglai-enclave.systems/
- Penglai OSDI paper: https://www.usenix.org/system/files/osdi21-feng.pdf
- RISC-V AP-TEE: https://github.com/riscv-non-isa/riscv-ap-tee
- RISC-V AP-TEE-IO: https://github.com/riscv-non-isa/riscv-ap-tee-io
- CoVE paper: https://arxiv.org/abs/2304.06167
- RISC-V AP-TEE implementation guidance: https://riscv.org/wp-content/uploads/2025/10/RISC-V-Implementing-Application-Processor-TEEs-REV-1.pdf
- Salus: https://github.com/rivosinc/salus
- ACE-RISCV: https://github.com/IBM/ACE-RISCV
- OpenTitan documentation: https://opentitan.org/documentation/
- OpenTitan security model: https://opentitan.org/book/doc/security/
- OpenTitan secure boot: https://opentitan.org/book/doc/security/specs/secure_boot/
- OpenTitan shutdown/escalation: https://opentitan.org/book/sw/device/silicon_creator/rom/doc/shutdown.html
- OpenTitan integration paper: https://arxiv.org/abs/2406.11558
- Aster Android/Arm CCA paper: https://arxiv.org/abs/2407.16694
- Confidential LLM inference in TEEs: https://arxiv.org/abs/2509.18886
- Intel/Google TDX assessment: https://arxiv.org/abs/2602.11434
- RISC-V TEE lifecycle toolkit: https://arxiv.org/abs/2603.17757
