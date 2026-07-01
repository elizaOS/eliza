# Road To MediaTek

Status: planning paper
Date: 2026-05-17
Scope: Eliza e1-chip to Android-capable AI SoC, FPGA experiment, and tapeout-readiness path.

This is not a completion report. The current repository is still a e1-chip
and CPU/AP scaffold. It has useful RTL, BSP, physical-design, package, FPGA,
KiCad, Android, benchmark, and evidence gates, but it does not yet contain a
verified Linux or AOSP boot on the Eliza simulated chip.

## External Reference: Dimensity 9400

MediaTek Dimensity 9400 is the requested comparison point. Public specs are
enough to define target classes, but not enough to clone the implementation.
The closed parts are the real product moat: CPU tuning, GPU/NPU/ISP/modem
firmware, memory controller/PHY, power management, RF, BSP, calibration,
certification, manufacturing, and validation infrastructure.

Public Dimensity 9400 capability anchors:

| Area | Public capability | Eliza implication |
| --- | --- | --- |
| Process | TSMC second-generation 3 nm class | Open PDK tapeout experiments will be orders of magnitude behind flagship density and power. Use open PDKs for discipline, not competitive phone silicon. |
| CPU | Armv9.2 all-big-core design; Cortex-X925 at 3.62 GHz; public claims of higher single/multi-thread performance | Eliza needs a real RV64GC Linux-capable AP path first, then an RVA23-class multi-core target, then performance work. The current tiny CPU scaffold is not comparable. |
| Memory | LPDDR5X-10667 support | Eliza must define UMA, coherency, IOMMU, QoS, bandwidth counters, and an LPDDR PHY/IP boundary. The current SRAM/AXI-lite model is not phone-class. |
| GPU/display | Immortalis-G925 12-core GPU; ray-tracing and power-efficiency claims | Eliza v0 should not attempt a flagship GPU. It needs DRM/KMS/framebuffer/HWC first, then a 2D/composition path, then optional open GPU integration. |
| NPU | 8th generation NPU with agentic AI claims, faster diffusion, faster LLM prompt performance, MLLM token-generation claims, LoRA/on-device training claims | Eliza must graduate from MMIO tiny GEMM to descriptor queues, DMA-fed scratchpad, INT8/INT4 tensor tile, compiler/runtime, and Android HAL proof. |
| Camera/ISP | Imagiq 1090, HDR zoom, AI-ISP features, 4K60 efficiency claims | v0 must explicitly exclude camera ISP or use an external module/reference board. A real phone roadmap needs CSI/ISP/sensor calibration/Camera HAL. |
| Audio | Up to six microphone recording path and high-resolution Bluetooth audio claims | v0 needs I2S/audio stub only; phone path needs codec, routing, Audio HAL, latency, power, and acoustic validation. |
| Display | MiraVision 1090, HDR formats, foldable-display support | v0 needs simple scanout plus HWC path; phone path needs panel bridge/DSI/eDP, color, brightness, vsync, composition, power, and underflow tests. |
| Cellular | Integrated 3GPP Release-17 5G modem, sub-6 carrier aggregation, DSDA claims | Eliza should not build a modem in v0. Use certified external modem modules if making a phone product. |
| Wi-Fi/Bluetooth | External/new 4 nm Wi-Fi 7/Bluetooth combo chip; tri-band Wi-Fi 7 and up to 7.3 Gbps public data-rate claim | Eliza should use an external Wi-Fi/BT module over SDIO/PCIe/UART/USB with firmware and regulatory boundaries. |

Sources: MediaTek Dimensity 9400 product page, AOSP overview, AOSP Cuttlefish
docs, AMD VCU118 product page, and a 10.6M parameter TinyStories model on
Hugging Face:

- [MediaTek Dimensity 9400](https://www.mediatek.com/products/smartphones/mediatek-dimensity-9400)
- [AOSP overview](https://source.android.com/docs/setup/about)
- [AOSP Cuttlefish get started](https://source.android.com/docs/devices/cuttlefish/get-started)
- [AMD VCU118 evaluation kit](https://www.amd.com/pt/products/adaptive-socs-and-fpgas/evaluation-boards/vcu118.html)
- [vijaymohan/gpt2-tinystories-from-scratch-10m](https://huggingface.co/vijaymohan/gpt2-tinystories-from-scratch-10m)

## Current Eliza State

The current project is best described as an evidence-driven scaffold:

| Area | Current capability | Current blocker |
| --- | --- | --- |
| RTL e1 chip | Verilator/cocotb/formal-oriented e1-chip modules exist. | It is not an Android-capable application processor. |
| CPU/AP | Docs and generated Chipyard/Rocket artifacts exist in places; local RTL has a tiny CPU scaffold. | No verified RV64GC/OpenSBI/Linux/userspace transcript from the selected AP simulator. |
| Memory | AXI-lite SRAM/DRAM models, DRAM-controller RTL/sim evidence, and memory contract docs exist. | No phone-class LPDDR PHY/training/capacity/timing evidence, coherency, cache hierarchy, full IOMMU/Linux integration, or QoS evidence. |
| NPU | Tiny MMIO/GEMM/scratchpad prototype and 2028 NPU target docs exist. | No DMA-fed tensor engine, descriptor ABI, compiler backend, Android delegate, or benchmark proof. |
| Display | Display scanout/timing scaffold and Android HWC scaffold exist. | No framebuffer-fetch proof tied to Linux/Android SurfaceFlinger/HWC transcript. |
| Wi-Fi | External module contracts exist. | No SDIO/PCIe enumeration, firmware load, traffic, Android framework, or regulatory evidence. |
| Linux BSP | DTS, driver, Buildroot, OpenSBI, and U-Boot scaffolds exist. | External tree import/build/runtime evidence is missing. |
| AOSP BSP | Device tree, init, fstab, VINTF, SELinux, HWC/NPU HAL scaffolds exist. | No vendorimage/checkvintf/SELinux/Cuttlefish/QEMU/Renode strict evidence set. |
| FPGA | ULX3S e1-demo path and VCU118/FireSim plan exist. | Stage-1 board revision/pins and stage-2 Rocket+Gemmini implementation evidence are incomplete. |
| PD/tapeout | OpenLane/OpenROAD configs, signoff manifests, package/padframe docs exist. | No complete GDS/DEF/DRC/LVS/STA/power/congestion release evidence. |
| Board/package | KiCad planning project and package docs exist. | Package is still placeholder-level; no foundry/package-vendor release or lab validation. |

## Checklist 1: Run AOSP On Simulated Chip And A Tiny HF Model

Goal: AOSP reaches userspace on a simulator tied to the Eliza hardware
contract, and a tiny Hugging Face language model runs through a measured CPU or
NPU path with honest fallback accounting.

### A. Select And Freeze The Simulated AP

- Choose one AP path: Chipyard Rocket first, CVA6 second, custom later.
- Pin generator repo SHA, submodules, Scala/SBT versions, Verilator version,
  toolchain version, OpenSBI version, Linux version, Buildroot version, and AOSP
  branch.
- Generate one canonical manifest containing source hashes, commands,
  generated Verilog/FIRRTL, DTS, memory map, reset vector, UART, timer,
  interrupt controller, and DRAM window.
- Gate: generated AP manifest is reproducible from a clean checkout.

### B. Make The AP Simulator Executable

- Build the selected Verilator simulator without timestamp churn forcing
  unnecessary rebuild loops.
- Fix macOS/Rosetta runtime issue by running long RTL Linux tests on native
  Linux x86_64 or Linux arm64, not Docker amd64 under macOS Rosetta.
- Add simulator health modes: reset-only, UART-only, OpenSBI-only, Linux-initrd,
  Buildroot shell, Android-init attempt.
- Gate: simulator binary SHA and build transcript are archived.

### C. Firmware And Boot Chain

- Build OpenSBI for the exact generated platform or use a generic payload path
  only if the hardware ABI matches.
- Add U-Boot only after OpenSBI/Linux direct payload is stable.
- Build a minimal boot ROM or reset shim that jumps to OpenSBI deterministically.
- Bind DTB placement and memory reservations to the generated DRAM window.
- Gate: OpenSBI banner transcript reaches next stage.

### D. Linux Bring-Up

- Build RISC-V Linux Image with serial console, earlycon, initramfs, timer,
  interrupt controller, MMU, tmpfs, devtmpfs, and Eliza driver config.
- Build minimal Buildroot initramfs with `/init`, shell, busybox, and
  `e1-mmio-smoke`.
- Verify CPU ISA/profile, cache/MMU behavior, timer IRQ, external IRQ,
  UART console, and memory map.
- Gate: Linux boots to userspace and runs `e1-mmio-smoke`.

Required transcripts:

- `eliza_e1_opensbi_boot.log`
- `eliza_e1_linux_boot.log`
- `eliza_e1_trap_timer_irq.log`
- `eliza_e1_isa_cache_mmu.log`
- `eliza_e1_ap_benchmarks.log`

### E. Android Reference First, Hardware-ABI Second

- Run AOSP Cuttlefish on Linux with KVM as the fast software reference path.
- Build `eliza_ai_soc-userdebug` device scaffold in an external AOSP tree.
- Archive strict logs: lunch, vendorimage, checkvintf, SELinux build,
  neverallow, CTS/VTS plan, Cuttlefish smoke, QEMU smoke, Renode smoke.
- Only after Linux boots on the AP simulator, attempt Android init/userspace on
  that simulator.
- Gate: `sys.boot_completed=1` is evidence only if tied to the declared target.

### F. Tiny Hugging Face Model Path

- Start with `vijaymohan/gpt2-tinystories-from-scratch-10m` or an equivalent
  pinned TinyStories model. It is 10.6M params, F32, short context, and not a
  factual QA model.
- Convert to a deterministic format:
  - CPU baseline: ONNX or TFLite.
  - llama.cpp/GGUF path only if the model architecture is supported or converted
    cleanly.
  - NPU path: static INT8/INT4 matmul kernels first, then runtime delegate.
- Archive model SHA-256, tokenizer SHA-256, prompt set, expected tokens, and
  output transcript.
- Measure tokens/sec, model load time, memory footprint, CPU fallback percent,
  unsupported ops, simulated cycles, and accelerator counters.
- Gate: benchmark report passes `docs/benchmarks/report-schema.yaml`.

## Checklist 2: Open-Source Gaps Versus MediaTek/Qualcomm Class

Level of effort uses this scale:

- S: 1-4 weeks for one strong engineer.
- M: 1-3 months.
- L: 3-9 months.
- XL: 9-24 months.
- XXL: multi-year team or commercial/IP dependency.

| Gap | Why it matters | Open-source status | LOE |
| --- | --- | --- | --- |
| Flagship CPU core | Phone responsiveness and Android app performance depend on high single-thread IPC and efficient multi-core scheduling. | Rocket/CVA6/BOOM are useful, but not near Cortex-X925/Oryon class. | XXL |
| RISC-V Android kernel/GKI parity | Android production devices need kernel, ABI, VTS/CTS, vendor interfaces, and long-term maintenance. | RISC-V AOSP work exists, but phone-grade upstream support is incomplete and moving. | XL |
| GPU with Android drivers | SurfaceFlinger, games, UI composition, Vulkan/OpenGL, ML interop. | Open GPUs/drivers exist in pieces; phone-class GPU IP remains closed. | XXL |
| NPU compiler/runtime | Model support, quantization, graph lowering, HAL, fallback accounting. | IREE/TVM/MLIR/TFLite/ExecuTorch help, but a custom NPU backend is major work. | XL |
| ISP/camera stack | Phones are camera products. Sensor tuning and ISP firmware are enormous. | Open camera stacks do not replace flagship ISP and tuning. | XXL |
| Cellular modem/RF | Certification, carrier approval, power, emergency calling, SIM/eSIM. | Open implementation is not practical for v0. Use certified modules. | XXL |
| Wi-Fi/Bluetooth stack | Connectivity and regulatory compliance. | Linux drivers/modules exist for selected chips, but firmware/regulatory remain vendor-bound. | L/XL |
| LPDDR PHY/controller | Android/AI needs bandwidth and power efficiency. | PHY is usually foundry/IP/vendor closed. Controller may be open-ish, PHY is not. | XXL |
| Coherency/IOMMU/QoS | UMA correctness, display underflow, NPU security, DMA isolation. | Open interconnects exist, but phone-class verification is large. | XL |
| Power/thermal management | Sustained performance and safety. | Linux frameworks exist; silicon sensors, PMIC, firmware, DVFS need platform work. | XL |
| Secure boot/TEE/keys | Android Verified Boot, rollback, debug lock, credentials. | Open components exist, but secure production integration is difficult. | XL |
| PD/tapeout signoff | Real chip release. | OpenROAD/OpenLane usable, but advanced-node signoff requires commercial tools/PDKs. | XXL |
| Lab validation | Power, thermal, SI/PI, RF, display, audio, compliance. | Tools exist; procedure and equipment cost dominate. | L/XL |

## Checklist 3: Work You Can Do On A Mac

Mac work is best for specification, source generation, fast local simulation,
schema checks, docs, software scaffolds, and light RTL verification. It is not
the right host for long Linux RTL simulation under Rosetta.

### Mac: Immediate

- Run repo hygiene:
  - `make docs-check`
  - `make stub-audit`
  - `make platform-contract-check`
  - `make phone-soc-claim-check`
  - `make mvp-status`
- Fix stale doc paths after the `docs/` move.
- Keep all claim gates fail-closed.
- Run Verilator e1-chip smoke.
- Run QEMU/Renode firmware smoke where tools are installed.
- Maintain platform-contract JSON and generated headers/DTS fragments.
- Edit Android device tree, HAL scaffold, init, fstab, VINTF, and SELinux
  source.
- Build host-side NPU runtime tests and Python golden models.
- Write and run cocotb tests that complete quickly.
- Run Yosys syntax/synthesis checks for small blocks.
- Run benchmark dry-runs and schema validation.
- Prepare KiCad planning docs and schematic/PCB source edits.
- Prepare BOM, package, pinout, padframe, and evidence manifests.

### Mac: Useful But Bounded

- Generate Chipyard configs and inspect generated DTS/memmap.
- Build small firmware payloads if RISC-V GCC is installed.
- Run Cuttlefish only indirectly through a Linux VM with KVM support if the Mac
  host can expose virtualization in a useful way. For serious AOSP, use native
  Linux.
- Use Docker for short checks; avoid long amd64 RTL Linux simulations under
  Rosetta.

### Mac: Not A Good Fit

- Full AOSP builds.
- Long Verilated Linux boot on generated AP.
- FireSim FPGA builds.
- VCU118 Vivado flows.
- OpenLane/OpenROAD full signoff if tool/PDK container performance is unstable.
- Lab instrument automation that requires Linux-only vendor drivers.

## Checklist 4: Work That Should Run On Linux

Use a native Linux workstation or cloud instance for long-running builds and
boot evidence. Minimum recommended host: 16-32 cores, 128 GB RAM, 1-2 TB NVMe.

### Linux: Simulator And OS Bring-Up

- Build Chipyard/Rocket or CVA6 simulator natively.
- Build OpenSBI.
- Build U-Boot when needed.
- Build Linux kernel and DTB.
- Build Buildroot initramfs.
- Run Verilator Linux boot for many hours without Rosetta.
- Capture OpenSBI/Linux/userspace transcripts.
- Run Renode/QEMU OS smoke.
- Run AOSP Cuttlefish with KVM. AOSP docs require virtualization/KVM checks for
  Cuttlefish.
- Build external AOSP tree and `eliza_ai_soc-userdebug` artifacts.
- Run `checkvintf`, SELinux policy build, neverallow, and CTS/VTS smoke plans.

### Linux: Hardware/FPGA

- Stage 1 ULX3S: Yosys, nextpnr-ecp5, ecppack, openFPGALoader.
- Stage 2 VCU118: Vivado, board files, DDR4 MIG, UART/JTAG scripts.
- FireSim: AWS manager, Vivado-backed bitstream build, metasim, FPGA runs.
- Capture UART/JTAG logs and power measurements.

### Linux: PD/Tapeout

- OpenLane/OpenROAD/Yosys/Magic/Netgen/KLayout/OpenSTA Docker or native flow.
- Sky130/GF180 PDK setup with pinned commits.
- Block-level hardening, top-level integration, DRC/LVS/STA/power reports.
- Release archive generation with exact tool versions and report hashes.

### Linux: AI Runtime

- Build ONNX Runtime, TFLite, IREE, TVM, llama.cpp, or ExecuTorch experiments.
- Convert and quantize the 10M TinyStories model.
- Run CPU baseline and NPU simulator backend.
- Generate benchmark reports with model hashes and fallback accounting.

## Checklist 5: FPGA And Lab BOM

Prices are planning estimates as of 2026-05-17. Check stock before buying.

### Stage 1: Cheap Open E1-Demo FPGA

| Item | Purpose | Estimated cost |
| --- | --- | ---: |
| ULX3S 85F | Open-source ECP5 board for e1-demo MMIO path | $155-$250 |
| USB-C/micro-USB cables, known-good data | Power/programming/serial | $20 |
| PMOD jumper kit / headers | GPIO bring-up | $20-$50 |
| Logic analyzer, 8-16 channel | UART/SPI/GPIO capture | $15-$200 |
| Bench supply, 0-30 V current-limited | Board bring-up safety | $80-$250 |
| Basic DMM | Voltage/current checks | $30-$150 |
| ESD mat/wrist strap | Handling | $25-$80 |
| MicroSD cards | FPGA/boot experiments | $20 |
| Total | Practical stage-1 lab | ~$365-$1,000 |

### Stage 2: Serious SoC FPGA

| Item | Purpose | Estimated cost |
| --- | --- | ---: |
| AMD/Xilinx VCU118 EK-U1-VCU118-G | Rocket+Gemmini-class FPGA prototyping, DDR4, PCIe, transceivers | $14,995 list |
| Linux workstation | Native Vivado/Chipyard/AOSP/Verilator | $3,000-$8,000 |
| Extra NVMe storage, 4-8 TB | AOSP, builds, traces | $300-$900 |
| USB/JTAG platform cable spare | Robust programming/debug | $100-$400 |
| UART adapters, isolated if possible | Console capture | $20-$150 |
| Active cooling/bench fan/thermal camera optional | Sustained FPGA tests | $50-$600 |
| Total | Owned stage-2 path | ~$18,500-$25,000 |

VCU118 public AMD page lists the kit at $14,995, XCVU9P device, DDR4, RLDRAM3,
QSFP+, PCIe Gen3 x16, FMC/FMC+, integrated JTAG, QSPI flash, microSD, and
included Vivado Design Edition voucher.

### Measurement And Validation Equipment

| Item | Purpose | Estimated cost |
| --- | --- | ---: |
| 100-200 MHz oscilloscope | Clocks, reset, power rails, simple SI | $300-$1,500 |
| 4-channel 500 MHz+ oscilloscope | Better DDR/fast-edge/debug work | $2,000-$8,000 |
| Current probe or inline power monitor | Power traces | $100-$2,000 |
| USB protocol analyzer | USB device/host validation | $400-$5,000 |
| SDIO/eMMC analyzer | Storage/Wi-Fi host debug | $1,000-$10,000 |
| Wi-Fi 6/7 AP plus attenuators/shield box | Connectivity validation | $300-$5,000 |
| Thermal camera | Hotspot and sustained-run validation | $300-$2,000 |
| Reflow/hot-air/rework station | Board repair | $100-$800 |
| Microscope | Solder/jumper inspection | $100-$800 |

### Fabrication/Tapeout Planning Costs

| Item | Purpose | Estimated cost |
| --- | --- | ---: |
| Prototype PCB fabrication/assembly | E1-demo board | $300-$3,000 |
| Stencils, spare components, fixtures | Assembly/debug | $100-$1,000 |
| Open MPW shuttle | Sky130/GF180 learning chip | Varies, often subsidized or low thousands |
| Commercial shuttle + package | More controlled silicon experiment | $10,000-$100,000+ |
| Advanced-node phone-class tapeout | Competitive phone SoC | Multi-million to tens/hundreds of millions |

## Milestone Ladder

| Milestone | Definition of done |
| --- | --- |
| M0: Honest scaffold | All docs/checks distinguish scaffold from proof; stale paths fixed. |
| M1: E1-chip executable | Verilator/QEMU/Renode firmware smoke with transcripts. |
| M2: AP simulator generated | Chipyard/Rocket or CVA6 AP manifest, DTS, Verilog, simulator binary. |
| M3: OpenSBI boot | OpenSBI banner and handoff transcript from AP simulator. |
| M4: Linux userspace | Kernel/initramfs boots; timer/IRQ/MMU/cache evidence archived. |
| M5: Android reference | AOSP Cuttlefish riscv64 or selected target reaches userspace with logs. |
| M6: Eliza Android scaffold build | `eliza_ai_soc-userdebug` vendorimage/checkvintf/SELinux evidence. |
| M7: Android on AP simulator attempt | Android init progress on Eliza AP simulator, even if slow. |
| M8: Tiny model baseline | 10M TinyStories model runs on CPU baseline with reproducible report. |
| M9: Tiny NPU acceleration | Static INT8/INT4 kernels run on NPU simulator with fallback accounting. |
| M10: FPGA stage 1 | ULX3S e1-demo bitstream and UART/GPIO evidence. |
| M11: FPGA stage 2 | VCU118/FireSim Rocket+NPU prototype boot evidence. |
| M12: Open PDK GDS | Block-level and top-level OpenLane/OpenROAD reports archived. |
| M13: Tapeout review | DRC/LVS/STA/power/package/padframe/board blockers resolved or waived. |

## Critical Policy

- Do not call QEMU virt, Cuttlefish, or Renode software-reference success
  "Android on our chip."
- Do not call simulator wall-clock performance a MediaTek/Qualcomm comparison.
- Do not count fake-tool tests as execution evidence.
- Do not count a model run as NPU acceleration without hardware/runtime counters
  and CPU fallback accounting.
- Do not call a package/padframe/board releasable until vendor/foundry/lab
  evidence exists.
- Do not attempt flagship GPU, cellular modem, ISP, LPDDR PHY, Wi-Fi RF, PMIC,
  or battery charging silicon in v0.

## Next Work Orders

1. Fix current local gates after docs relocation.
2. Build native Linux AP simulator host.
3. Generate and pin one Rocket AP target.
4. Build OpenSBI and Linux initramfs payloads.
5. Capture OpenSBI/Linux transcripts.
6. Run AOSP Cuttlefish riscv64 reference and archive evidence.
7. Integrate Eliza AOSP device scaffold into external AOSP and archive
   build/VINTF/SELinux evidence.
8. Pin and convert the 10.6M TinyStories model.
9. Build CPU baseline benchmark report.
10. Add NPU runtime shim with explicit unsupported-op/fallback accounting.
11. Bring up ULX3S e1-demo bitstream.
12. Start VCU118 or FireSim path only after M4 Linux userspace is stable.
