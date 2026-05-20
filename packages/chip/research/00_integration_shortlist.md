# Eliza E1 2028 SOTA 14A Integration Shortlist

Date: 2026-05-19
Status: triage_complete_all_high_confidence_rows_landed
Claim boundary: this is a research-triage planning document. Each row maps to
implementation work tracked under the same packet's `03_implementation/` plan
and the existing repo evidence gates. Nothing here promotes any silicon,
boot, MLPerf, or PD claim.

## Implementation snapshot (2026-05-19, both waves complete)

Every High-confidence shortlist row is now on `develop`. Each item
carries an opt-in `make` target that fails closed when its evidence is
missing.

| Item        | Status | Artifact                                                                                                                                    | Validator                                |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A-1, A-2, A-4 | landed | `docs/arch/npu.md` + `docs/spec-db/e1-npu-runtime-contract.json` + `docs/spec-db/npu-2028-roadmap.yaml` (MX, group INT4, sparse-tile spec) | `make npu-runtime-contract-check`        |
| A-3 (BitNet ternary) | landed | RTL: `rtl/npu/e1_npu.sv` (`dot16_ternary_mode_q`, lane decode 00/01/10, reserved 11 rejected); cocotb: 5 cases in `verify/cocotb/test_e1_npu.py` | `make cocotb-npu`                        |
| A-5 (DMA writeback spec) | landed | `docs/arch/npu.md` writeback semantics + `descriptor_word_template` + `command_buffer_image` + `docs/spec-db/npu-2028-roadmap.yaml` L1 TODO | `make npu-roadmap-check`                 |
| A-8 (perf counters)  | landed | `rtl/npu/e1_npu.sv` `PERF_STALL_CYCLES`/`PERF_SCRATCH_BYTES`/`PERF_THERMAL_THROTTLE` + contract + check script                                | `make npu-runtime-contract-check`        |
| B-1..B-5    | landed | `compiler/runtime/{e1_npu_stablehlo,e1_npu_partitioner,e1_executorch_delegate,e1_litert_delegate}.py` + `e1_litert_delegate.h` + `CommandBuffer` on `e1_npu_runtime.py` + 46 new pytest cases | `make typecheck` + `pytest compiler/runtime` |
| C-1..C-7    | landed | `docs/spec-db/cpu-2028-target.yaml`                                                                                                          | `make cpu-2028-target-check`             |
| D-1..D-9    | landed | `docs/spec-db/memory-2028-target.yaml`                                                                                                       | `make memory-2028-target-check`          |
| E-1..E-8    | landed | `docs/spec-db/security-2028-target.yaml`                                                                                                     | `make security-2028-target-check`        |
| F-1..F-5    | landed | `docs/sw/{opensbi,u-boot,buildroot,linux}/README.md` + `sw/aosp-device/device/eliza/eliza_ai_soc/` skeleton + Makefile `aosp-build-{preflight,riscv64}` | `make aosp-bsp-check`                    |
| G-1         | landed | `verify/formal/e1_*.sby` + `verify/formal/bpu/{ras,ftq}.sby` — bitwuzla as second SBY engine alongside z3                                    | `make formal`                            |
| G-2 (cocotb-coverage) | landed | `verify/cocotb/coverage_helpers.py` + cover-points in 5 testbenches + `scripts/check_cocotb_coverage.py` + Makefile `cocotb-coverage`         | `make cocotb-coverage`                   |
| G-3 (reset/CDC props) | landed | `verify/properties/reset_properties.sv` + `cdc_properties.sv` referenced from all `.sby`                                                     | `make formal`                            |
| G-4 (AXI-Lite props) | landed | `verify/properties/axi_lite_protocol.sv` + `verify/formal/e1_axi_lite_{interconnect,dram}.sby` + `*_bind.sv`                                  | `make formal`                            |
| G-5 (Accelergy/Timeloop) | landed | `benchmarks/sim/run_npu_timeloop.py` + `benchmarks/sim/configs/e1_npu_timeloop_arch.yaml` + merge with SCALE-Sim                              | `make benchmark-sim-metrics` (BLOCKED if Timeloop not installed) |
| G-6 (Hypothesis) | landed | `benchmarks/parsers/tests/test_parsers_hypothesis.py` + `scripts/test_check_cocotb_coverage_hypothesis.py`                                    | included in pytest run                   |
| G-7 (MLPerf Power schema) | landed | `docs/benchmarks/report-schema.yaml` `energy_joules_per_inference` field + threaded through `benchmarks/run_benchmarks.py`                  | `make benchmark-parser-test`             |
| H-1..H-4    | landed | `pd/openlane/config.sky130.json` (`DESIGN_REPAIR_MAX_SLEW_PCT=5`, `MAX_CAP_PCT=5`, explicit `FP_PDN_*` topology, PSM + IR-drop enabled) + `pd/signoff/run-manifest.schema.json` (psm_ir_drop_report, pdn_topology, 8 tool-digest fields) + `scripts/{check_pd_signoff.py,record_tool_digests.sh}` | `make pd-signoff-manifest-check`         |
| H-5         | landed | `scripts/check_pd_utilization.py` + `pd/signoff/util_threshold.yaml`                                                                          | `make pd-util-check`                     |
| I-1..I-6    | landed | `docs/spec-db/process-14a-effects.yaml` (variant_requirements, library_variant_binding, reliability_derate_sources, sram_vmin_ecc_repair_plan, thermal_capture_phases, packaging_default) | `make process-14a-effects-check`         |
| J-1..J-6    | landed | `package/{display,pmic,usb-pd,charger,sensors,audio}/` + `docs/board/{power-tree,pdn-budget,antenna-plan,thermal-stack}.md` + `board/kicad/e1-phone/` skeleton | `make board-package-evidence-check`      |
| L-tier      | tracked | all `03_implementation/*` Low-confidence items remain deferred to v1/v2                                                                       | n/a                                      |

### Locally-verified gates (chip side)

After this wave the following all pass with no claim movement:

```text
make lint                              PASS
make typecheck                         PASS
make docs-check                        PASS
make cpu-2028-target-check             PASS
make memory-2028-target-check          PASS
make security-2028-target-check        PASS
make npu-2028-target-check             PASS
make npu-runtime-contract-check        PASS
make npu-roadmap-check                 PASS
make process-14a-effects-check         PASS
make pd-util-check                     BLOCKED (no util JSON in any local OpenLane run — fail-closed)
make platform-contract-check           PASS
make project-plan-check                PASS
make prototype-status-dashboard-check  PASS
```

### What stays BLOCKED (external dependencies, by design)

1. **Cuttlefish RV64 / AOSP boot transcript** — Linux host + ~600 GB AOSP
   checkout + ART RV64 toolchain. Recipe lives in
   `sw/aosp-device/build-aosp-riscv64.sh` and Makefile `aosp-build-{preflight,riscv64}`.
2. **OpenSBI + U-Boot + Linux qemu-virt smoke** — RV cross-toolchain + upstream
   trees. Recipes live in `docs/sw/{opensbi,u-boot,buildroot,linux}/README.md`.
3. **OpenLane silicon-class signoff** — OpenLane 2 Docker + Volare PDK
   on disk. `make openlane` runs locally, takes hours.
4. **AOSP HAL evidence transcripts** — `docs/evidence/android/*_smoke.log`
   carries `status=FAIL` placeholders until real device boot transcripts
   are captured.
5. **MLPerf Mobile / MLPerf Power closed loop** — L5/L6 evidence, requires
   fabricated silicon + Joulescope/Monsoon. Cannot exist pre-silicon.
6. **Foundry PDK selection** — `selected_process_option` stays
   `blocked_until_foundry_pdk_and_library_selection_from_shortlist`; the
   shortlist covers TSMC N2P / A14, Samsung SF2, Intel 14A, Rapidus N2.

No chip claim has been promoted past its existing fail-closed status.

## OS RV64 bring-up snapshot (2026-05-19, both waves complete)

Claim boundary: `status_report_view_only_no_silicon_or_boot_claim`. The
rows below describe scaffolding and gate plumbing that exists on
`develop`. Nothing here asserts that the live ISO has actually been
built, that a qemu-virt boot has been captured, or that any hardware
RISC-V board has come up. The fail-closed gate
(`make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-strict`)
exists precisely so a future contributor cannot promote the variant
past `planned` without producing the missing artifacts.

The userspace bring-up of the RV64 stack lives outside `packages/chip/`,
under `packages/os/linux/variants/elizaos-debian-riscv64/`. The four
commits below land the build config, the qemu-virt boot harness, the
systemd userland bootstrap, and the e2e release-manifest gate. They are
the OS-side mirror of the chip-side `aosp-simulator-completion-gate.yaml`
+ `tapeout-readiness` aggregator surface.

| Item                                                          | Status  | Artifact                                                                                                                                                                                                                                                                                                                                                                | Validator                                                                                                                              |
| ------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OS-RV64-1 Wave 4 live-build config (`c4656f1810`)             | landed  | `packages/os/linux/variants/elizaos-debian-riscv64/{Dockerfile,build.sh,auto/config,config/package-lists/elizaos.list.chroot,config/hooks/normal/0010-elizaos-agent.hook.chroot,config/hooks/normal/0020-grub-efi-riscv64.hook.binary,config/includes.binary/extlinux/extlinux.conf,manifest.json.template}` | `docker build -t elizaos-debian-riscv64-builder .` (build still external; `lb build` BLOCKED on multi-hour run + Debian mirror)        |
| OS-RV64-2 qemu-virt boot harness (`ebf816ea14`)               | landed  | `packages/os/linux/variants/elizaos-debian-riscv64/{Makefile,scripts/qemu_virt_boot.sh,scripts/qemu_virt_smoke.py,scripts/test_qemu_virt_smoke.py}`                                                                                                                                                                                                                      | `make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-virt-boot-test`                                                        |
| OS-RV64-3 userland bootstrap Wave 2B (`31bd8f13ba`)           | landed  | `packages/os/linux/variants/elizaos-debian-riscv64/{config/hooks/normal/0030-elizaos-userland.hook.chroot,config/includes.chroot/etc/systemd/system/elizaos-agent.service,config/includes.chroot/etc/systemd/system/elizaos-first-boot.service,config/includes.chroot/usr/lib/elizaos/first-boot.sh,config/package-lists/elizaos-runtime.list.chroot,docs/userland-startup.md}` | systemd + `elizaos-first-boot.service` + first-boot script ship `elizaos-ready instance=<uuid>` on `/dev/ttyS0`; consumed by OS-RV64-2 |
| OS-RV64-4 e2e runbook + release-manifest gate (`cc10b9f001`)  | landed  | `packages/os/linux/variants/elizaos-debian-riscv64/{Makefile,docs/e2e-qemu-virt.md,scripts/check_release_manifest.py,scripts/test_check_release_manifest.py}`                                                                                                                                                                                                            | `make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check` (informational) / `release-check-strict` (release pipeline) + `release-check-test`                  |

### Locally-runnable gates (OS side)

These three targets execute from a fresh checkout without external
mirrors, ISOs, qemu state, or hardware:

```text
make -C packages/os/linux/variants/elizaos-debian-riscv64 qemu-virt-boot-test     PASS  (qemu_virt_smoke unit tests)
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check           BLOCKED (no real manifest.json with collected evidence; manifest.json.template is `provenance: scaffolding`)
make -C packages/os/linux/variants/elizaos-debian-riscv64 release-check-test      PASS  (check_release_manifest unit + Hypothesis tests)
```

### What stays BLOCKED on the OS RV64 path (by design)

1. **Actual `lb build` run.** 45-90 minute build, multi-GB Debian Trixie
   riscv64 mirror pull. Recipe in
   `packages/os/linux/variants/elizaos-debian-riscv64/docs/e2e-qemu-virt.md`
   step 2. No ISO is committed; no hash is fabricated.
2. **qemu-virt boot transcript.** Requires the artifact from BLOCKED-1
   plus `qemu-system-riscv64` on the host. Step 3 of the e2e runbook;
   evidence path is `evidence/qemu_virt_boot.json` against schema
   `eliza.os.linux.qemu_virt_boot.v1`. Until this lands, the
   `qemu-virt-boot` evidence row stays `status: missing`.
3. **elizaOS agent binary publication.** First-boot script writes the
   `elizaos-ready` marker even when the binary is absent, but the
   `STATUS_LATER_AGENT_BINARY` marker file at
   `/opt/elizaos/STATUS_LATER_AGENT_BINARY` stays present until the
   agent installer hook replaces the placeholder. Owned by the elizaOS
   agent-release pipeline, not by this variant.
4. **Hardware board boot.** The `hardware-board-boot` evidence row is
   `not-required` for the qemu-virt artifact and stays BLOCKED for any
   hardware variant until the chip board bring-up team produces a
   transcripted boot on real silicon. No silicon claim is made by any
   of these four commits.

### Cross-references

- Chip-side tape-out aggregator: `make -C packages/chip tapeout-readiness`
  (39 PASS / 0 FAIL / 8 BLOCKED on 2026-05-19) — the chip-side mirror of
  the OS-side `release-check` gate.
- A future top-level `make chip-os-bring-up-status` aggregator (owned by
  the integration aggregator agent, not landed in this wave) will
  combine the chip-side `tapeout-readiness` view with the OS-side
  `release-check` view into a single status surface. Until it lands,
  run the two gates separately and read both outputs.
- One-page OS-side status doc:
  [`packages/os/linux/variants/elizaos-debian-riscv64/STATUS.md`](../../os/linux/variants/elizaos-debian-riscv64/STATUS.md).
- chip-side software dependencies the OS variant consumes:
  `packages/chip/docs/sw/opensbi/README.md`,
  `packages/chip/docs/sw/u-boot/README.md`,
  `packages/chip/docs/sw/linux/README.md`,
  `packages/chip/docs/android/riscv-bringup.md`.

No OS RV64 boot, ISO, or hardware claim has been promoted past its
existing BLOCKED status.

## Goal

Build a chip that runs **2028 SOTA mobile AI models** at the highest possible
**performance per watt** in a 14A-class mobile process. Every shortlist item
is screened against three filters:

1. **Useful?** Does it move a numeric target in `docs/spec-db/npu-2028-target.yaml`,
   `cpu-2028-target.yaml` (to be authored), `process-14a-effects.yaml`, or
   `docs/architecture-optimization/`?
2. **Tractable in silicon?** Is the change a small RTL delta, a spec-db
   contract update, or a verification harness extension we can execute now,
   versus a multi-year microarch program that only makes sense after Phase B?
3. **Power-per-watt benefit?** Does the item reduce energy per inference, per
   token, per pixel, or per cycle for the modeled workload mix (LLM decode,
   transformer prefill, vision encoder, attention, KV-cache, framebuffer
   blits, camera pipeline)?

Items below carry a `useful / tractable / benefit` tuple plus the experiment
list, the sub-agent owner, and the canonical files the work lands in.

## Shortlist by subsystem

### A. NPU datapath, opcodes, and tile architecture

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| A-1 | OCP Microscaling (MXFP8/MXFP6/MXFP4/MXINT8) block-scale operand fetch | Y | spec now, RTL L2 | Energy: MX block scale + low-precision FP → 2-3× perf/W vs INT8 GEMM on transformer prefill; aligns with Blackwell + Trillium | `ocp_mx_spec`, `mx_formats_paper`, `microxcaling_repo`, `ptq_mx_paper` |
| A-2 | Group-scaled INT4 weights (W4A16) `GEMM_S4_GS{32,64,128}` | Y | spec + small RTL | LLM decode dominant precision; cuts weight BW 4×, KV decode energy ~50% | `gptq_paper`, `awq_paper`, `omniquant_paper`, `hqq_repo` |
| A-3 | BitNet ternary mode on `DOT16_S2` (sign-flip + sum, no multiply) | Y | small RTL + cocotb | Halves activation MAC energy; only viable INT2 path with deployed weights (BitNet b1.58, MediaTek NPU990) | `bitnet_b1_58_paper`, `bitnet_a4_8_paper`, `bitnet_2b4t_hf` |
| A-4 | Tile-level 2:4 sparse INT4 GEMM (lifted from scalar `SDOT4_S4_2_4`) | Y | medium RTL | Trainium2 demonstrates 4× sparse-INT8 ratio; same pattern for INT4 doubles effective TOPS on pruned LLMs | `sparsegpt_paper`, `wanda_paper`, `maskllm_paper`, `trainium2_aws_docs` |
| A-5 | DMA writeback path (descriptor engine) | Y | medium RTL | Binding L1 phase gate; closes `dma_trace_bytes_written` / `perf_counter_dma_bytes_written`; no NPU can scale past scratchpad without it | `nvdla`, `mtia_v2_isca25`, current `docs/arch/npu.md` |
| A-6 | FlashAttention-2-style streaming-softmax attention engine, INT8/FP8 KV | Y | RTL L3 (planned) | Eliminates O(N²) attention materialisation; mandatory for 2028 LLM-class context; KV BW dominates power on decode | `flashattention2_paper`, `flashattention3_paper`, `fusemax_paper`, `spatten_paper` |
| A-7 | Paged-KV block-table load path | Y | spec + small RTL | Concurrent-context serving (npu-2028-target `concurrent_contexts_min: 8`) requires page indirection; also enables MLA + GQA + speculative decoding | `vllm_paged_attention`, `streamingllm_paper`, `h2o_paper`, `kivi_paper`, `deepseek_v2_mla` |
| A-8 | Expanded perf counters (cycles, stall, SRAM BW, DMA BW, thermal throttle) | Y | small RTL | Required for power-per-counter attribution at L1/L2; closes the `basic_performance_counters` gap in `npu-2028-target.yaml` | `accelergy_repo`, `timeloop_paper`, MTIA papers |

Verdict: A-1..A-3 + A-5 + A-8 implementable now (spec + RTL + cocotb). A-4 + A-6 + A-7 land later but get spec-db gates and integration plans now.

### B. NPU compiler & runtime

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| B-1 | StableHLO entry-IR canonicalisation for `e1_npu_lowering.py` | Y | now | Connects E1 to JAX / PyTorch export / LiteRT / IREE; replaces ad-hoc schemas | `openxla_stablehlo`, `iree_repo`, `liteRT_blog` |
| B-2 | ExecuTorch delegate skeleton | Y | now | Mobile PyTorch runtime; Exynos 2600 explicitly cites ExecuTorch; mandatory mobile path | `executorch_repo`, `samsung_exynos_2600_page` |
| B-3 | LiteRT (TFLite) delegate skeleton | Y | now | LiteRT ingests StableHLO; shared internal compiler with B-1/B-2 | `liteRT_blog`, `tflite_delegate_docs` |
| B-4 | Descriptor-ring `CommandBuffer` runtime abstraction | Y | now | Batched dispatch eliminates per-op MMIO sync; tracks IREE Stream dialect; prereq for B-5 | `iree_stream_dialect`, `docs/arch/npu-microarch.md` |
| B-5 | Partitioner with op-set + tile-bound table | Y | now | Required to measure `cpu_fallback_percent_max: 1` and `unsupported_operator_percent_max: 1` | `executorch_partitioner_docs`, `iree_repo` |
| B-6 | Flash-Decoding split-K decode scheduling | Y | medium | On-device LLM decode is GEMV-shaped; split-K saturates tile fabric | `flashdecoding_paper`, `flashattention2_paper` |
| B-7 | IREE backend as single compiler entry (HAL driver) | Y | spec | Avoid fragmenting compiler effort; declared software target | `iree_repo`, `npu-2028-target.yaml#software_targets.compiler` |

Verdict: B-1..B-5 all implementable as new Python modules under `compiler/runtime/`. No RTL dependencies.

### C. CPU subsystem & ISA

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| C-1 | Author `docs/spec-db/cpu-2028-target.yaml` | Y | now | Symmetry with NPU/process spec-db; gates Phase B selection | research/cpu_subsystem_2026 H1 |
| C-2 | Pin RVV 1.0 as only accepted vector ISA (forbid RVV 0.7.1) | Y | now | Android RV upstream requires RVA22U64+V | `rvv_1_0_spec`, `rise_project` |
| C-3 | Pin RVA22U64+V as Android baseline; RVA23 long-term | Y | now | Forecloses non-Android extension drift | `rva22_profile`, `rva23_profile` |
| C-4 | Record Zicbom/Zicbop/Zicboz as required cache-maintenance ISA | Y | now | Linux RV upstream DMA cache management uses these; replaces vendor CSRs | kernel.org RV cache-maintenance docs |
| C-5 | Add Ibex as named management/security hart | Y | now | OpenTitan compatibility; aligns with security packet H1 | `ibex_repo`, `opentitan_repo` |
| C-6 | Track Saturn vector engine, BOOM Phase B, AIA/Sstc as deferred items | Y | now | Bring up plan without overcommitting | `saturn_repo`, `boom_v4`, `aia_spec`, `sstc_spec` |
| C-7 | Verification primitives list (Spike, Sail, RISCOF, riscv-formal, riscv-dv) | Y | now | Independent of core selection; survives a Rocket→BOOM swap | `spike_repo`, `sail_riscv_repo`, `riscof_repo`, `riscv_formal_repo`, `riscv_dv_repo` |

Verdict: all spec-db / docs work; no RTL changes. Implementable now.

### D. Memory subsystem & coherent fabric

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| D-1 | Replace AXI-Lite scaffold with TileLink-C (planning + spec-db) | Y | spec now, RTL L2+ | Coherent fabric is the binding gate on cache-coherent CPU submission, IOMMU isolation, SLC; AXI-Lite cannot scale | `tilelink_spec`, `chipyard_constellation`, `chi_e_spec` |
| D-2 | LPDDR6 controller boundary spec (96-128 bit, 12.8-14.4 Gb/s, on-die ECC, link CRC, TRR+RFM) | Y | spec now | Only path to ≥180 GB/s peak / 120 GB/s sustained; satisfies `external_memory_bandwidth_gbps_min: 180` | `jedec_lpddr6_pre_pub`, `samsung_lpddr5x_brief`, `sk_hynix_lpddr5t` |
| D-3 | SMMU/IOMMU spec (per-master stream IDs: NPU CMD/DATA, GPU, display, camera, modem, audio) | Y | spec now | L3 gate `iommu_isolated_command_buffers`; baseline for confidential VM | `arm_smmuv3`, `riscv_iommu` |
| D-4 | 32 MiB SLC bank spec (banked 4-8 ways, coherent) | Y | spec | Closes `shared_system_cache_mib_min: 32`; cache stash entry for NPU command submission | `sram_2nm_isscc`, `tilelink_inclusive_cache`, `chi_e_spec` |
| D-5 | 64 MiB NPU tiled SRAM spec (8-16 tiles, 4 MiB each, SECDED, ping/pong) | Y | spec | Closes `local_sram_mib_min: 64` + `local_sram_bandwidth_tbps_min: 20`; weight-stationary throughput driver | `tsmc_2nm_sram_iedm2023`, `samsung_2nm_sram_isscc2024`, `eyeriss_v2_paper` |
| D-6 | Compression-aware DMA spec (64-element block, INT8/INT4/INT2/FP8 modes) | Y | spec + medium RTL | 2-3× DRAM BW savings on ReLU-heavy feature maps; closes `compression_aware_dma` | `afbc_arm`, `nvdla` |
| D-7 | DRAM controller QoS classes (Isochronous/High/Normal/Best-effort) | Y | spec | Closes `QoS_for_camera_display_audio_modem`; required for sustained AI+camera+display contention | `parbs_paper`, `atlas_paper`, `bliss_paper` |
| D-8 | RowHammer policy (TRR + RFM + on-die ECC + link CRC counters) | Y | spec | Reliability + security; aligns with `M6` in security packet | `rowhammer_paper`, `jedec_rfm_prac` |
| D-9 | Cache stash for CPU→NPU command submission | Y | RTL L2+ | Cuts CPU→NPU command latency by ~100 ns; closes `cache_coherent_cpu_submission` | `chi_cache_stash` |

Verdict: D-1..D-8 all become spec-db updates now. RTL lands after CPU/AP Phase B.

### E. Security / Root of Trust

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| E-1 | Spec-db adoption of OpenTitan IP set (rom_ctrl, lc_ctrl, otp_ctrl, keymgr, aes, hmac, entropy_src/csrng/edn, Ibex sec-MCU) | Y | spec now | Apache-2.0 silicon-proven IP; unblocks every BLOCKED row under `docs/security/secure-boot-lifecycle-evidence.md` | `opentitan_rom_ctrl`, `opentitan_lc_ctrl`, `opentitan_otp_ctrl`, `opentitan_keymgr`, `opentitan_aes`, `opentitan_hmac`, `opentitan_entropy_src` |
| E-2 | AVB 2.0 / libavb BL2 verifier spec | Y | spec now | AOSP-standard; rollback index landed in OTP partition; covers TC-BOOT-001…008 | `libavb_repo`, `avb_2_0_spec` |
| E-3 | Ed25519 verify on OTBN + SHA-256 via HMAC (no software-only crypto on boot path) | Y | spec now | Constant-time; OpenTitan reference programs already verified | `opentitan_otbn_ed25519`, `opentitan_hmac` |
| E-4 | dm-verity hashtree + FEC for system/vendor/product | Y | spec now | AOSP default; ~50 MB hashtree on 5 GB system fits BL2 budget | `dm_verity_kernel_docs`, `fs_verity_kernel_docs` |
| E-5 | ePMP/Smepmp on every hart + IOPMP on interconnect (deny-by-default) | Y | spec now | Ratified RV standards; provides DMA isolation that the threat model assumes | `epmp_spec`, `iopmp_spec`, `smepmp_spec` |
| E-6 | DICE / Open DICE measurement chain | Y | spec now | KeyMint attestation root; ~1500 LOC Apache-2.0 | `open_dice_repo`, `tcg_dice_spec` |
| E-7 | Synthetic OTP for Sky130 prototype (clearly-labelled non-production) | Y | now | Unblocks simulator transcripts without claiming production OTP | research/security_2026 H8 |
| E-8 | PQC verify (hybrid Ed25519 + ML-DSA-65) reserved `header_version=2` | Y | spec | Hedges Ed25519; OpenTitan OTBN can run ML-DSA-65 | `fips_204_ml_dsa`, `pqc_hw_paper` |

Verdict: all spec/docs items implementable now. RTL adoption is integration work after Phase B.

### F. BSP / Linux / Android RV

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| F-1 | OpenSBI 1.6 FW_DYNAMIC + U-Boot RV64 + Buildroot rv64gc qemu-virt smoke recipe (READMEs + capture scripts) | Y | now | First real software-side execution path; unblocks F-2..F-5 chain | `opensbi_1_6`, `u_boot_rv64`, `buildroot_riscv64_virt` |
| F-2 | `aosp_cf_riscv64_phone` template at `docs/sw/aosp-device/device/eliza/eliza_ai_soc/` | Y | now (skeleton only) | Closes the AOSP simulator-completion gate scaffold without claiming boot | `aosp_cuttlefish_rv64`, `vintf_spec` |
| F-3 | libe1_npu + LiteRT delegate + ExecuTorch backend as canonical HAL story | Y | spec | Aligns Android NN path; NNAPI relegated to legacy compat only | `liteRT_blog`, `executorch_repo`, `aicore_android_16` |
| F-4 | DT-only contract (no ACPI) declared in spec-db | Y | now | Closes any future ACPI ambiguity; matches mainline mobile RV | `kernel_riscv_dt` |
| F-5 | SBI feature floor (v2.0 + Sscofpmf + DBCN + Sstc) recorded | Y | now | Reproducible OpenSBI builds | `opensbi_sbi_3_0_draft`, `sscofpmf_spec`, `sstc_spec`, `dbcn_spec` |

Verdict: F-1..F-5 are docs/README + spec-db work. Actual qemu-virt runs need RV toolchain installed locally; we document the recipe and capture script paths so a future contributor can run them.

### G. Benchmarks / simulators / formal

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| G-1 | Add Bitwuzla as a second SBY engine across all `.sby` | Y | now | Closes Workstream E Bitwuzla gap; Boolector is EoM; second SMT solver catches different bugs | `bitwuzla_repo`, `boolector_eom_announcement` |
| G-2 | cocotb-coverage + JSON merge step | Y | now | Closes "no coverage report" gap in Workstream A; per-block opcode/MMIO/IRQ/AXI cover-points | `cocotb_coverage_repo` |
| G-3 | Reset + CDC properties in `verify/properties/` | Y | now | Short, high-catch-rate, currently absent | `verify/properties/` existing dir |
| G-4 | AXI-Lite open protocol properties + new `.sby` files | Y | now | Workstream A names this explicitly | open AXI-Lite property file refs |
| G-5 | Accelergy + Timeloop integration into NPU sim flow | Y | now | Emits joules-per-inference column required by `benchmark-matrix.md` | `accelergy_repo`, `timeloop_paper` |
| G-6 | Hypothesis-based property tests for parsers / check scripts | Y | now | Replaces example-based unit tests; better edge coverage | `hypothesis_python` |
| G-7 | MLPerf Power-style integrated energy schema field | Y | spec | Adds `energy_joules_per_inference` with calibration metadata | `mlperf_power_spec` |

Verdict: G-1..G-6 are direct file changes in `verify/`, `benchmarks/`, `scripts/`. All implementable now.

### H. Physical design / EDA

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| H-1 | Tighten OpenROAD `repair_timing` / `repair_design` margins | Y | now | Reduces 23k max-slew + 442 max-cap violations on 2026-05-19 release run | `openroad_repair_timing_docs` |
| H-2 | OpenROAD PSM static IR-drop step in OpenLane flow + signoff schema | Y | now | Closes the most-cited gap in `physical-power-thermal.md` | `psm_openroad_docs`, `physical_power_thermal_workorder` |
| H-3 | Explicit PDN topology block in `pd/openlane/config.sky130.json` | Y | now | Auditable PDN topology per run | `pdngen_openroad_docs` |
| H-4 | Pin and record tool digests (OpenLane image, Volare PDK, KLayout/Magic/Netgen/OpenROAD/Yosys/ABC) per run | Y | now | Closes Workstream E reproducibility blocker | `docker_oci_spec` |
| H-5 | Utilization regression gate (fail if util > 1.05) | Y | now | Permanent fail-closed for the historical 771.788% incident | research/pd_eda_2026 H5 |
| H-6 | (Tracked) AutoDMP / CircuitNet ML predictors as informational gates | Y | spec | Comparative baseline for macro placement when hard macros exist | `autodmp_repo`, `circuitnet_2_0` |

Verdict: H-1..H-5 are direct config + script changes. Implementable now.

### I. Process / packaging (spec-db only)

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| I-1 | Keep frontside-PDN baseline + BSPDN as parallel variant in `process-14a-effects.yaml`; require IR/EM/thermal per variant | Y | now | Locks the contract to the published foundry roadmap reality | `intel_powervia_vlsi2023`, `tsmc_super_power_rail`, `samsung_bspdn_iedm2023` |
| I-2 | Bind NanoFlex/FinFLEX cell library variant selection in PD library manifest | Y | now | Captures cell-library DTCO choices the foundry exposes | `tsmc_nanoflex`, `samsung_finflex` |
| I-3 | Adopt nanosheet-specific reliability derates (BTI, self-heating, Mo/Ru EM) | Y | now (spec) | Replaces FinFET-era lifetime derates | `bti_nanosheet_ted2023`, `self_heating_nanosheet_edl2024`, `em_advanced_beol_tdmr2024` |
| I-4 | SRAM Vmin/ECC/repair plan: SECDED + bit-interleaving + repair-fuse policy + BIST | Y | now (spec) | Closes `sram_density_vmin_and_ecc` blocker | `tsmc_2nm_sram_iedm2023`, `samsung_2nm_sram_isscc2024`, `soft_error_advanced_node_iolts2024` |
| I-5 | Thermal capture split: vapor-chamber transient vs post-saturation steady-state | Y | now (spec) | Sustained TOPS/W must come from post-saturation phase | `vapor_chamber_phone_review`, `aosp_thermal_hal` |
| I-6 | Default monolithic die + InFO_oS memory-on-package; chiplet split is a separate variant | Y | now (spec) | Locks the package contract; avoids CoWoS-class out-of-envelope plans | `intel_lunar_lake`, `snapdragon_x_elite`, `tsmc_info` |

Verdict: all spec-db / docs updates. No RTL or PD impact.

### J. Mobile platform / board / package

| ID | Item | Useful | Tractable | Benefit | Source IDs |
| --- | --- | :---: | :---: | --- | --- |
| J-1 | `package/display/v0-dsi-720x1280.yaml` panel binding | Y | now | First concrete v0 panel evidence; mirrors `package/wifi/` pattern | `mipi_dsi_2`, PinePhone Pro panel refs |
| J-2 | `package/pmic/da9063.yaml` + `package/usb-pd/tps65987.yaml` + `package/charger/max77860.yaml` | Y | now | PMIC rail-to-power-island binding required before board layout | `dialog_da9063`, `ti_tps65987`, `maxim_max77860` |
| J-3 | `docs/board/power-tree.md` + `pdn-budget.md` + `antenna-plan.md` + `thermal-stack.md` | Y | now | Closes the explicit board-side blockers in `phone-platform.md` | research/mobile_platform_2026 H4..H7 |
| J-4 | `package/sensors/v0-sensors.yaml` (BMI323 + BMP390 + AK09918 + TSL2591) | Y | now | Mainline-driven sensor BOM | Bosch/AK/AMS datasheets |
| J-5 | `package/audio/v0-codec.yaml` (Realtek/TI codec + Cirrus smart amp + Knowles PDM mics) | Y | now | I2S + PDM bonded pins forecast | Realtek/TI/Cirrus/Knowles datasheets |
| J-6 | KiCad 9 + IPC-2581 + kibot CI skeleton at `board/kicad/e1-phone/` | Y | now | Mirrors MNT Reform + PinePhone Pro repos | `kicad_9`, `ipc_2581_b`, `kibot_repo` |

Verdict: all yaml + docs work. No RTL or PD impact.

## Items deferred (do not implement now)

These are real but premature for the current phase:

- A-4 lifted tile-level 2:4 sparsity (waits for Phase B fabric / Gemmini wrapper).
- A-6 full FlashAttention-2 attention engine (microarch L3).
- A-9 (R-CIM-SLOT) CIM tile slot (waits for 14A PDK availability).
- B-7 single IREE backend commitment (decision after B-1..B-5 land and exhibit pain).
- D-1 actual TileLink-C RTL replacement (Phase B + Chipyard regen).
- D-5 actual 64 MiB tile SRAM RTL (Phase B + foundry SRAM macro selection).
- E-1 actual OpenTitan instantiation (Phase B + license accounting + DV).
- F-1 actual qemu-virt boot capture (needs local RV toolchain run).
- I-1..I-6 stay as spec-db-only; no PD change.
- J-1..J-6 stay as planning yaml; no fabrication.

## Implementation experiments by sub-agent

Each sub-agent below owns a non-overlapping path scope, may commit to the
current `develop` branch, must respect `packages/chip/CLAUDE.md` and
`AGENTS.md`, and must keep every claim evidence-backed.

| Sub-agent | Path scope | Items in scope |
| --- | --- | --- |
| `npu_rtl_ops` | `rtl/npu/`, `verify/cocotb/test_e1_npu*`, `verify/verilator/test_npu*`, `compiler/runtime/e1_npu_runtime.py`, `docs/arch/npu.md`, `docs/spec-db/e1-npu-runtime-contract.json`, `scripts/check_e1_npu_runtime_contract.py` | A-3 (BitNet ternary), A-8 (perf counters), A-5 (DMA writeback spec wiring) |
| `npu_compiler` | `compiler/runtime/`, `compiler/runtime/test_*` | B-1..B-5 |
| `npu_spec` | `docs/spec-db/e1-npu-runtime-contract.json`, `docs/spec-db/npu-2028-target.yaml`, `docs/spec-db/npu-2028-roadmap.yaml`, `docs/arch/npu.md`, `docs/arch/npu-microarch.md` | A-1 spec, A-2 spec, A-4 spec, A-6 spec, A-7 spec |
| `cpu_spec` | `docs/spec-db/cpu-2028-target.yaml` (new), `docs/arch/cpu-subsystem.md`, `docs/arch/linux-capable-cpu-contract.md` | C-1..C-7 |
| `memory_spec` | `docs/spec-db/memory-2028-target.yaml` (new), `docs/arch/memory-subsystem.md`, `docs/arch/interconnect.md` | D-1..D-9 (spec-only) |
| `security_spec` | `docs/arch/security.md`, `docs/security/*.md`, `docs/spec-db/security-2028-target.yaml` (new) | E-1..E-8 (spec-only) |
| `bsp_docs` | `docs/sw/opensbi/README.md`, `docs/sw/u-boot/README.md`, `docs/sw/buildroot/README.md`, `docs/sw/linux/README.md`, `docs/sw/aosp-device/device/eliza/eliza_ai_soc/` | F-1..F-5 |
| `bench_verify` | `verify/formal/*.sby`, `verify/properties/`, `verify/cocotb/`, `benchmarks/`, `scripts/check_cocotb_coverage.py`, `requirements.txt` | G-1..G-7 |
| `pd_flow` | `pd/openlane/config.sky130.json`, `pd/signoff/run-manifest.schema.json`, `scripts/check_pd_signoff.py`, `scripts/check_pd_utilization.py` (new) | H-1..H-5 |
| `process_spec` | `docs/spec-db/process-14a-effects.yaml`, `docs/manufacturing/`, `docs/arch/memory-subsystem.md`, `docs/arch/npu-microarch.md` | I-1..I-6 |
| `platform_spec` | `package/display/`, `package/pmic/`, `package/usb-pd/`, `package/charger/`, `package/sensors/`, `package/audio/`, `docs/board/`, `board/kicad/e1-phone/` (skeleton only) | J-1..J-6 |

Each agent must:

1. Commit changes incrementally on `develop` per `AGENTS.md` git rules
   (no stash, no branch switching, no force-push).
2. Run the relevant `make` target before its final commit: `make lint`,
   `make typecheck`, `make docs-check`, and the subsystem-specific check.
3. Report what landed, what was deferred, and what was blocked.
4. Stay inside the path scope above. If a change touches another scope,
   it is recorded as a follow-up item, not implemented in this pass.
