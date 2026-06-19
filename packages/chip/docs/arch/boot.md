# Boot flow

## E1 chip

The e1 chip debug-visible boot ROM is an identity/contract ROM used by
simulation and synthesis checks:

```text
0x0000_0000 = "OPSO"
0x0000_0004 = "CHIP"
0x0000_0008 = contract version 1
0x0000_000C = boot vector placeholder
```

The package-level e1 chip still uses the package debug nibble bridge as its board-smoke bus master. The machine-readable software contract is `sw/platform/e1_platform_contract.json`; generated software constants live in `sw/platform/generated/e1_platform_contract.h`.

The CPU subsystem boundary now has a tiny executable RISC-V path for simulation proof. In the focused CPU/contract wrapper, a loader writes a program into the DRAM aperture at `0x8000_0000`, then releases `e1_tiny_cpu_contract` with `RESET_PC=0x8000_0000`. The CPU fetches from DRAM, executes the minimal integer subset documented in `docs/arch/cpu-subsystem.md`, and halts on `ECALL`.

`fw/boot-rom` contains a minimal executable RV64 reset scaffold. It starts at
`0x0000_0000`, sets `mtvec` to a local WFI trap loop, disables machine
interrupts, sets a small ROM-local stack pointer, and jumps to the current
DRAM handoff address `0x8000_0000`.

The scaffold is intentionally not secure boot and not an OpenSBI handoff. It
does not authenticate payloads, initialize DRAM, provide SBI services, build a
device tree, or prove OS boot. `make bootrom-check` builds the ELF/bin/hex
artifact when a local RISC-V toolchain is available and otherwise reports the
executable artifact stage as blocked after semantic checks pass.

The Linux memory-system handoff is therefore blocked. A production boot path
must define reset ROM ownership, boot SRAM base/size/lifetime, DRAM
initialization and training, cacheability attributes for ROM/SRAM/DRAM/MMIO,
and the OpenSBI handoff record that proves Linux sees initialized memory rather
than the current SRAM-backed test aperture.
The identity ROM remains a contract ROM for the package debug path, not a full firmware ROM. A production boot handoff still needs ROM code that sets up M-mode state and jumps to OpenSBI or another firmware payload.

Secure boot evidence is absent. A production chain must authenticate a
signature, enforce rollback indexes, select A/B slots, validate recovery/OTA,
and fail closed before mutable firmware runs.

Exact gate terms: authenticate a signature; enforce rollback indexes; select
A/B slots; validate recovery/OTA; fail closed before mutable firmware.

QEMU and Renode do not model this ABI yet. They are qemu-virt software reference targets for early firmware scaffolding, with their own CPU, RAM, and UART contract.

## Full SoC target

```text
reset
management core starts from ROM
clock/reset controller releases application CPU
OpenSBI runs in M-mode
U-Boot loads kernel, initramfs, and device tree
Linux boots with serial console
Android userspace boots on the same hardware contract
```

For the CPU/AP workstream, this full flow is not closed by QEMU, Renode, the
tiny CPU, or a selected single Rocket manifest. The evidence gate requires real
generated-target transcripts for OpenSBI, Linux, trap/timer/IRQ behavior,
ISA/cache/MMU state, and benchmark metadata before any Linux-capable AP claim is
allowed. Android compatibility remains a separate CTS/VTS/userspace gate.

## Current AP Boot Blockers

The selected AP target is the pinned Chipyard `ElizaRocketConfig` import
path in `generators/chipyard/eliza-rocket-manifest.json`. It is still
`selected_not_generated`; `build/chipyard/eliza_rocket/bootstrap-preflight.json`
records that the checkout exists but recursive Chipyard submodules are not
initialized at the recorded SHAs. Until that preflight passes, the generated AP
Verilog, simulator, and boot DTS are absent.

`sw/linux/dts/eliza-e1.dts` is a repo-local e1 MMIO peripheral source,
not the complete AP boot device tree. It currently compiles with `dtc`, but it
lacks the boot-critical CPU, memory, CLINT/ACLINT timer, PLIC/interrupt
controller, and enabled UART console nodes that OpenSBI and Linux need. Audit
the selected generated DTS with:

```sh
python3 scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc
```

Audit the checked-in peripheral DTS explicitly with:

```sh
python3 scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc \
  --path sw/linux/dts/eliza-e1.dts
```

Those audits are blockers only; they do not create boot evidence. Real
OpenSBI/Linux progress still requires generated AP artifacts and external
transcripts ingested through `scripts/capture_cpu_ap_evidence.py intake`.
