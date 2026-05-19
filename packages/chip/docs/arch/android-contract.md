# Android hardware contract

The e1 chip does not boot Android. It establishes the minimal hardware contracts that will later back Linux drivers and AOSP HALs.

The central software-visible contract is `sw/platform/e1_platform_contract.json`. Android, Linux, and Buildroot scaffolding must consume that contract or generated artifacts from it instead of copying register addresses into unchecked placeholders.

The Linux-capable CPU SoC variant of the e1 chip is described by the
`e1_chip_cpu_variant` section of that contract. The authoritative
artifacts derived from it live under `sw/platform/generated/`:

| Artifact | Authoritative for |
| --- | --- |
| `sw/platform/generated/e1_platform.vh`       | RTL decode / Verilog headers |
| `sw/platform/generated/e1-platform.dtsi`     | Linux kernel DTS includes |
| `sw/platform/generated/e1_platform.h`        | U-Boot, OpenSBI, bare-metal firmware |
| `sw/platform/generated/e1_platform_hal.json` | AOSP HAL configs |

These four files are produced by `scripts/gen_platform_artifacts.py`
(`make platform-artifacts`) and MUST NOT be edited by hand. CI runs
`make platform-contract-check`, which fails on stale artifacts and on
any handwritten DTS that references a contract device compatible at the
wrong base address.

QEMU/Renode bring-up uses a separate qemu-virt software reference target. Passing on qemu-virt proves boot scaffolding and userspace plumbing only; it does not prove the e1-chip package debug/MMIO ABI.

| Android need | E1 chip representation | Full SoC direction |
| --- | --- | --- |
| Boot identity | Boot ROM contract version | ROM, fuses/OTP abstraction, boot policy |
| Timers | Timer compare IRQ | CLINT/ACLINT plus Linux clocksource |
| Interrupts | Dedicated IRQ pins | PLIC/IMSIC routing |
| Display | Framebuffer and vsync registers | DRM/KMS driver and simple HWC path |
| NPU | Command/status/result registers | Linux char/DRM accel driver plus runtime/HAL |
| Storage | DMA-style command pattern | SD/eMMC controller first |
| GPIO/sensors | GPIO and I2C-oriented placeholder | GPIO, I2C sensor hub, input events |

The first AOSP target should live under `sw/aosp-device/device/eliza/eliza_ai_soc` and boot on QEMU/Renode before RTL simulation is expected to run Android-scale workloads. `make aosp-bsp-check` intentionally fails until that target contains real BoardConfig, init, manifest, SELinux, HAL plumbing tied back to the central contract, and checked-in external build/boot evidence.
