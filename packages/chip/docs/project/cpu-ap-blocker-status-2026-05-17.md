# CPU/AP blocker status

Date: 2026-05-17

Scope: `rtl/cpu/**`, CPU-facing contract tests, and project CPU/AP status.

## Current Local Artifact

The only in-repo executable CPU artifact is
`rtl/cpu/e1_cpu_subsystem_stub.sv`. Despite the legacy module name, it is a
tiny hand-written RV-style contract CPU, not a Linux-capable application
processor.

Locally proven by `make cocotb-cpu`:

- reset identity is exposed as `RESET_PC=0x8000_0000` and `HART_ID=0` in the
  CPU contract wrapper,
- fetch starts at the reset boundary,
- the tiny CPU executes the documented small integer/load/store/control-flow
  subset,
- unsupported, privileged, CSR, unaligned, and bus-error paths halt
  fail-closed,
- timer, software, and external interrupt inputs are pending-level placeholders
  only.

Not proven:

- RV64GC compliance,
- CSR/trap behavior,
- M/S/U privilege modes,
- interrupt or exception entry/return,
- CLINT/ACLINT timer/software interrupt compatibility,
- PLIC/IMSIC compatibility beyond the local claim/complete scaffold,
- MMU, page-table walks, caches, atomics, compressed instructions, floating
  point, or coherent memory,
- boot ROM execution, OpenSBI handoff, Linux boot, Android boot, UART console,
  or generated DTS consistency.

The single Rocket RV64GC hart is not a 2028 phone-class AP. It is acceptable as
the first Linux bring-up target only. A phone-class claim remains blocked on a
selected multi-hart or documented-equivalent CPU topology, ISA compliance,
cache/coherency/MMU evidence, sustained benchmark data, power/thermal
measurement, Android userspace evidence, and silicon/board evidence.

## Selected Open CPU/AP Path

The selected path is a generated Chipyard Rocket RV64GC subsystem. The selection
is pinned in `generators/chipyard/eliza-rocket-manifest.json`:

- Chipyard `main-2026-05-20`, commit
  `48f904aefbb3903dce6efa7901982642853ae6a7`
  (previous pin: `1.13.0` / `69eba860a352343e4ac6b6df0f3638a79a86ec78`),
- single Rocket RV64GC hart for first AP integration,
- project config name `ElizaRocketConfig`,
- production wrapper name `eliza_rocket_ap`,
- generated import manifest expected at
  `build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json`.

No generated Chipyard/Rocket RTL, simulator, DTS, firmware image, or boot log is
present in this repository yet. Therefore the CPU/AP path is blocked on external
generator integration, not on more hand-written tiny-CPU expansion.

## Host Checks

- `make chipyard-generator-check` verifies the selected AP path is pinned and
  non-claiming.
- `make chipyard-generated-check` is expected to fail until generated artifacts
  exist, the generated import manifest records recursive submodules, commands,
  tool versions, artifact paths, and SHA-256 values, and those paths validate
  against `docs/evidence/cpu-ap-evidence-manifest.json`.
- `make cpu-ap-evidence-check` is expected to fail until real OpenSBI/Linux and
  trap/timer/IRQ/cache/MMU/benchmark evidence logs exist. Archive real external
  transcripts with `python3 scripts/capture_cpu_ap_evidence.py intake ...`; the
  helper only accepts logs containing the manifest-required AP boot/trap/cache
  and benchmark markers.
- `make cpu-ap-completion-gate` stays blocked until the selected manifest makes
  a real AP claim and the generated artifacts plus transcripts validate.
- `sw/platform/e1_platform_contract.json` must remain `has_cpu=false` until
  generated CPU/AP artifacts and boot evidence exist.

Current missing evidence paths:

- `build/evidence/cpu_ap/eliza_e1_opensbi_boot.log`
- `build/evidence/cpu_ap/eliza_e1_linux_boot.log`
- `build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log`
- `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log`
- `build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log`

Next CPU/AP commands:

```sh
make chipyard-generator-check cpu-ap-scaffold-check cpu-ap-completion-gate
python3 scripts/check_chipyard_import_preflight.py --require-checkout
make chipyard-generated-check cpu-ap-evidence-check cpu-ap-completion-gate
```
# CPU/AP Blocker Status

The current checked-in CPU path is a tiny executable scaffold for contract
tests. It is not a Linux-capable application processor and must not be used as
phone CPU evidence.

## Current Gate

- The platform contract remains `has_cpu=false` until a production CPU is
  integrated at the package top.
- No generated Chipyard/Rocket RTL is checked in for the product CPU/AP path.
- OpenSBI plus Linux early console evidence is missing.

## Required Evidence

Before any Linux-capable CPU claim is unblocked, the repo needs checked
transcripts for OpenSBI, Linux early console, trap and interrupt behavior,
`mcause`, `mepc`, `mtimecmp`, external interrupt claim/complete, and
firmware-to-kernel handoff.
