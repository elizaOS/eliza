# Chipyard CPU Config Selection (v0)

Status: spec only. No generated RTL is checked in yet. This document selects the
v0 Chipyard configuration, pins the upstream SHA, and lays out the wrapper
directory layout that will hold the generated CPU subsystem once it is imported.

## Decision

v0 CPU subsystem is **Rocket RV64GC, single hart, SV39 MMU, L1 I$ + D$, with
CLINT and PLIC**. Wrapped in a thin AXI/TileLink adapter to the existing
`e1_linux_soc_contract` memory and MMIO contract. Rationale lives in
`docs/rtl/open_rtl_prototype_path.md`; this doc is the actionable selection.

| Item | Value | Notes |
| --- | --- | --- |
| Generator | `chipyard.harness.TestHarness` + `freechips.rocketchip.subsystem` | Single-hart Rocket subsystem. |
| Top config trait | `WithNBigCores(1)` | Big Rocket; matches RV64GC + SV39 by default. |
| ISA | RV64IMAFDC (RV64GC) | Default for `BigCore`. |
| Privilege modes | M, S, U | Required for OpenSBI + Linux. |
| MMU | SV39 (3-level page table, 39-bit VA) | Default for RV64 Rocket; adequate for first Linux boot. |
| Caches | 16 KiB L1 I$ (4-way), 16 KiB L1 D$ (4-way), 64 B line | BigCore defaults; tune later. |
| FPU | Single + double precision | Part of RV64GC. |
| Atomics | A extension | Required for SMP-capable Linux even at 1 hart. |
| Compressed | C extension | Required for OpenSBI/Linux RV64GC payloads. |
| CLINT | `freechips.rocketchip.devices.tilelink.CLINT` | mtime, mtimecmp, msip per hart. |
| PLIC | `freechips.rocketchip.devices.tilelink.PLIC` | M+S contexts per hart, >= 8 source IDs reserved. |
| Boot ROM | Replaced by the generated Rocket BootROM loaded from `fw/boot-rom/e1_boot_rom.bin` | See `docs/arch/boot-rom-spec.md`. |
| Debug | Standard Rocket `DebugModule` (DMI/JTAG) gated by life-cycle policy | See debug-lock policy in boot ROM spec. |
| External memory port | AXI4 master (via TileLink-to-AXI4 bridge) into `rtl/memory/` | Width 64; adapt to AXI-Lite32 only at the contract boundary for v0 cosim. |
| External MMIO port | AXI4-Lite master | Routes to existing `0x0C00_0000` (INTC alias) and `0x1001_0000` (DMA) windows. |

The CLINT and PLIC come from the Chipyard/Rocket generator; the existing
`e1_interrupt_controller` becomes a compatibility shim and will be retired
once the generated PLIC drives the downstream IRQ contract.

## Upstream pin

Pinned Chipyard reference (this is the floor; bump only with provenance
recorded under `build/evidence/cpu_ap/`):

```text
repo:    https://github.com/ucb-bar/chipyard
ref:     main-2026-05-20
SHA:     48f904aefbb3903dce6efa7901982642853ae6a7
record:  git -C external/chipyard rev-parse HEAD > build/evidence/cpu_ap/chipyard.sha
         git -C external/chipyard submodule status --recursive \
              > build/evidence/cpu_ap/chipyard-submodules.txt
```

Bootstrap is `scripts/bootstrap_chipyard.sh`; that script verifies the tag
resolves to the pinned SHA and checks it out detached. The generated AP path
still **must not** satisfy any release gate until the generated RTL manifest
and boot evidence are archived.

Generator invocation (target, not yet wired into `Makefile`):

```sh
cd external/chipyard
./scripts/init-submodules-no-riscv-tools.sh
make -C sims/verilator CONFIG=ElizaE1RocketConfig verilog
# emit Verilog only; do not run sim from this repo's CI
```

`ElizaE1RocketConfig` is a local config class that lives under
`rtl/wrappers/chipyard/src/main/scala/`. It composes Chipyard's
`AbstractConfig` with `WithNBigCores(1)`, the Eliza memory map
(`MemoryBusKey` at `0x8000_0000`), and the Eliza MMIO bus
(`PeripheryBusKey` carved to expose `0x0C00_0000` and `0x1001_0000`).

## Wrapper directory layout

All imported/generated artefacts live under `rtl/wrappers/` to keep them
isolated from the hand-written `e1_*` contract RTL:

```text
rtl/wrappers/
  README.md                              # provenance + regen instructions
  chipyard/
    src/main/scala/
      ElizaE1Config.scala         # Config class composition
      ElizaBootROM.scala             # references fw/boot-rom artefact path
    generated/                           # checked-in generated Verilog, machine written
      ElizaE1RocketTop.v          # generator output, DO NOT hand-edit
      ElizaE1RocketTop.fir        # FIRRTL for re-elaboration
      ElizaE1RocketTop.dts        # device tree fragment, checked vs sw/platform
      generated.manifest                 # chipyard SHA, scala/jdk, command, timestamp
    rocket_subsystem_wrapper.sv          # SV wrapper: clocks, resets, AXI bridges
    plic_compat_shim.sv                  # adapts generated PLIC IRQ ID space to existing
                                         # e1_interrupt_controller register window
    clint_axi_adapter.sv                 # exposes CLINT mtime/mtimecmp to debug-MMIO scan
  README_PROVENANCE.md
```

`rtl/wrappers/chipyard/generated/` is the only place generated RTL may live.
`scripts/run_rtl_check.sh` must refuse to include it in the default lint or
synthesis source list until the wrapper hand-off is signed off; until then it
is built only by the explicit `make rocket-elab` target.

## Integration steps

Each step is a separate logical commit on its own branch off `ws/cpu-boot-spec`:

1. **Archive upstream provenance.** Run `scripts/bootstrap_chipyard.sh`,
   archive `build/evidence/cpu_ap/chipyard.sha` plus recursive submodule
   status, and keep the manifest pin in
   `docs/generators/chipyard/eliza-rocket-manifest.json` in lockstep with this
   doc.
2. **Add Scala config.** Author `ElizaE1Config.scala` under
   `rtl/wrappers/chipyard/src/main/scala/`. No build wiring yet.
3. **Add elaboration target.** New `make rocket-elab` runs the Chipyard
   generator and copies output to `rtl/wrappers/chipyard/generated/` along
   with `generated.manifest`. Target is **not** invoked by `make smoke` or
   `make ci` until step 6 lands.
4. **Bridge RTL.** Add `rocket_subsystem_wrapper.sv` to translate the
   generated AXI4 ports to the AXI-Lite32 contract used by
   `e1_linux_soc_contract`. Width adapters live in this file only.
5. **Boot ROM hookup.** Reference the assembled stub from `fw/boot-rom/`
   (see `docs/arch/boot-rom-spec.md`) as the Chipyard `BootROMParams.contentFileName`.
6. **Verification crossover.** Wire a new cocotb top (`e1_rocket_soc_tb.sv`)
   that drops the wrapper into the contract harness, runs a `wfi` smoke and a
   CLINT timer interrupt smoke, and archives `build/evidence/cpu_ap/rocket_smoke.log`.
7. **Retire stub alias.** The tiny executable model now lives at
   `e1_tiny_cpu_contract.sv`; keep the thin `e1_cpu_subsystem_stub.sv`
   compatibility alias under the old name
   for one release cycle.

## Blocking gates (do not flip until evidence exists)

- `has_cpu = true` in any release manifest is forbidden until step 6 emits
  `build/evidence/cpu_ap/rocket_smoke.log` containing a CLINT mtimecmp
  interrupt entry and an OpenSBI banner.
- Synthesis (`make synth`) must continue to exclude generated Rocket Verilog
  until provenance and license review are recorded.
- Formal (`REQUIRE_SBY=1`) must not be claimed over generated RTL; only the
  wrapper SV files are in scope for the property set.
