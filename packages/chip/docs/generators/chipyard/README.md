# Chipyard Rocket AP Import

This directory records the selected real CPU/AP integration path. It is not
Linux boot evidence by itself.

The pinned path is Chipyard `main-2026-05-20` at commit
`48f904aefbb3903dce6efa7901982642853ae6a7` (previous pin: `1.13.0` /
`69eba860a352343e4ac6b6df0f3638a79a86ec78`), using a single Rocket RV64GC hart
in a project config named `ElizaRocketConfig`.

The repo-local config source is:

```text
docs/generators/chipyard/eliza/src/main/scala/eliza/ElizaRocketConfig.scala
```

`scripts/bootstrap_chipyard.sh` installs that overlay into the pinned checkout at
`external/chipyard/generators/chipyard/src/main/scala/eliza/ElizaRocketConfig.scala`.
It refuses to overwrite a different file at that destination.

This is a first Linux bring-up target, not a 2028 phone-class AP. Phone-class
claims remain blocked until a separate target boundary supplies topology, ISA
profile, cache/coherency, MMU, benchmark, power/thermal, Android, and silicon
evidence.

## Local Checks

Check the selected path without a Chipyard checkout:

```sh
python3 scripts/check_chipyard_generator_manifest.py
```

Record a lightweight bootstrap/import preflight without cloning or building if
`external/chipyard` is absent:

```sh
python3 scripts/check_chipyard_import_preflight.py
```

Require an already-bootstrapped checkout to match the pinned tag, commit, and
recursive submodule state, and to contain the installed ElizaRocketConfig
overlay:

```sh
python3 scripts/check_chipyard_import_preflight.py --require-checkout
```

Check the Chipyard environment needed to build the ElizaRocketConfig
Verilator simulator without modifying the checkout:

```sh
python3 scripts/check_chipyard_verilator_preflight.py
```

When that preflight passes, the expected Verilog generation command is:

```sh
cd external/chipyard/sims/verilator
source ../../env.sh
make CONFIG=ElizaRocketConfig CONFIG_PACKAGE=eliza verilog
```

The guarded repo wrapper runs the same preflight first and refuses to invoke
Chipyard make while setup blockers remain:

```sh
scripts/run_chipyard_eliza_verilator.sh
```

On a Linux host, the bounded one-command path for checkout, Chipyard setup, and
ElizaRocketConfig Verilog generation is:

```sh
CHIPYARD_RUN_SETUP=1 CHIPYARD_GENERATE_VERILOG=1 scripts/bootstrap_chipyard.sh
```

That command pins the checkout, installs only the repo-local
`ElizaRocketConfig` overlay, runs Chipyard `build-setup.sh`, then invokes
`scripts/run_chipyard_eliza_verilator.sh verilog`. It exits non-zero if the
checkout, submodules, overlay, generated `env.sh`, `RISCV`, Java, Verilator,
`firtool`, or RISC-V toolchain checks are not ready. A completed Verilog
generation is generated-collateral evidence only; it is not a Linux boot claim.

The explicit external generation sequence is:

```sh
cd /path/to/Eliza-AI-SoC
python3 scripts/check_chipyard_import_preflight.py --require-checkout
python3 scripts/check_chipyard_verilator_preflight.py
scripts/run_chipyard_eliza_verilator.sh
python3 scripts/generate_chipyard_eliza.py
python3 scripts/check_chipyard_generator_manifest.py --require-generated
python3 scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc
python3 scripts/check_chipyard_generated_linux_contract.py
```

`scripts/run_chipyard_eliza_verilator.sh` runs the host Chipyard simulator
make target after sourcing `external/chipyard/env.sh`:

```sh
cd external/chipyard/sims/verilator
source ../../env.sh
make CONFIG=ElizaRocketConfig CONFIG_PACKAGE=eliza
```

`python3 scripts/generate_chipyard_eliza.py` imports the generated source
tree, DTS, Verilog wrapper, simulator executable when present, tool versions,
submodule status, and SHA-256 values into
`build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json`. That
manifest is required before CPU/AP transcript intake, but it still does not
claim OpenSBI or Linux boot.

If Chipyard generated filelists or driver makefiles contain stale container
paths such as `/work/...`, check and rewrite only the generated path text with:

```sh
python3 scripts/repair_chipyard_generated_paths.py
python3 scripts/repair_chipyard_generated_paths.py --rewrite
```

The rewrite is deterministic: known generated Verilator filelists and
`VTestDriver.mk` references to `/work` are replaced with the current repository
root. It does not synthesize missing generated files. If the driver makefile or
model objects are missing, rerun the Chipyard simulator build.

`python3 scripts/check_chipyard_verilator_linux_smoke.py` reports progress
stages separately from pass/fail:

- `cpu_progress_to_payload`: instruction trace reached the payload address, but
  no OpenSBI marker was found.
- `opensbi_boot`: OpenSBI markers exist, but Linux markers are absent.
- `linux_boot`: Linux markers exist. This is still not accepted AP evidence
  until transcript intake validates and archives the required logs.

The Linux/amd64 container path uses the pinned local base image and writes the
full attempt transcript to `build/chipyard/eliza_rocket/docker-verilog-attempt.log`:

```sh
scripts/run_chipyard_eliza_docker.sh
```

The container must still expose the Chipyard build environment: `/opt/conda/bin`
on `PATH`, `make`, Java or the bundled SBT launcher runtime, Verilator, `firtool`,
and `RISCV` pointing at a RISC-V toolchain. The wrapper fails closed before
generation if those prerequisites are absent.

Require generated artifacts and evidence:

```sh
make chipyard-generated-check cpu-ap-evidence-check cpu-ap-completion-gate
```

Archive real external transcripts after the generated AP run. The intake helper
does not run a simulator and does not synthesize logs; it only validates logs
that already came from the generated AP target:

```sh
python3 scripts/capture_cpu_ap_evidence.py intake linux-boot \
  --source /path/to/linux-serial.log \
  --command '/exact/external/boot command'
python3 scripts/capture_cpu_ap_evidence.py intake isa-cache-mmu \
  --source /path/to/isa-cache-mmu.log \
  --command '/exact/external/isa-cache-mmu command'
python3 scripts/capture_cpu_ap_evidence.py intake ap-benchmarks \
  --source /path/to/ap-benchmarks.log \
  --command '/exact/external/benchmark command'
python3 scripts/capture_cpu_ap_evidence.py hashes
```

On a Linux host that already has the generated `ElizaRocketConfig`
simulator, OpenSBI/Linux payload, and target-side tests, use the guarded capture
wrapper to run real commands and archive each transcript into the required
paths:

```sh
python3 scripts/capture_cpu_ap_evidence.py template all

export ELIZA_GENERATED_MANIFEST=build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json
export ELIZA_OPENSBI_BOOT_CMD='cd external/chipyard/sims/verilator && source ../../env.sh && make CONFIG=ElizaRocketConfig CONFIG_PACKAGE=eliza BINARY=/abs/path/to/opensbi-linux.elf LOADMEM=1 run-binary'
export ELIZA_LINUX_BOOT_CMD='cd external/chipyard/sims/verilator && source ../../env.sh && make CONFIG=ElizaRocketConfig CONFIG_PACKAGE=eliza BINARY=/abs/path/to/opensbi-linux.elf LOADMEM=1 run-binary'
export ELIZA_TRAP_TIMER_IRQ_CMD='/abs/path/to/generated-ap-trap-timer-irq-test'
export ELIZA_ISA_CACHE_MMU_CMD='/abs/path/to/generated-ap-isa-cache-mmu-test'
export ELIZA_AP_BENCHMARKS_CMD='/abs/path/to/generated-ap-benchmark-runner'

python3 scripts/locate_chipyard_linux_payload.py --require
export CHIPYARD_LINUX_BINARY=/abs/path/to/linux-poweroff-bin-nodisk
make chipyard-generated-ap-boot
python3 scripts/check_chipyard_verilator_linux_smoke.py

scripts/capture_chipyard_linux_evidence.sh all
python3 scripts/capture_cpu_ap_evidence.py hashes
python3 scripts/check_cpu_ap_evidence.py --require-evidence
python3 scripts/check_chipyard_generated_linux_contract.py --require-boot-evidence
```

The wrapper writes raw command output under
`build/evidence/cpu_ap/raw/*.raw.log`, then calls
`scripts/capture_cpu_ap_evidence.py intake ...`. Accepted evidence lands at:

- `build/evidence/cpu_ap/eliza_e1_opensbi_boot.log`
- `build/evidence/cpu_ap/eliza_e1_linux_boot.log`
- `build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log`
- `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log`
- `build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log`

If a command is unset, exits nonzero, or lacks required OpenSBI/Linux/trap/cache
or benchmark markers, the capture remains blocked or fails and the accepted
evidence path is not written. The ISA/cache/MMU export is additionally gated by
the accepted Linux boot transcript: `build/evidence/cpu_ap/eliza_e1_linux_boot.log`
must pass intake and include `riscv_hwprobe: syscall rc=0`; a live diagnostic
smoke log alone does not unlock `ELIZA_ISA_CACHE_MMU_CMD`. The bare-metal
ISA/cache/MMU probe also audits the current generated DTS for the Rocket
I-cache, D-cache, L2 cache, TLB, and `mmu-type = "riscv,sv39"` markers before
archiving final evidence.

Generated Verilog must not be hand-edited. It should be copied or symlinked into
the eventual RTL wrapper location only through documented import steps so RTL
regressions remain reproducible.

## Local Manifests

- `eliza-rocket-manifest.json` is the repo-local selection gate. It must
  remain `selected_not_generated` until the generated import manifest,
  simulator run, firmware inputs, and boot/trap evidence exist. Loose generated
  Verilog, DTS, memmap, or regmap files under `build/chipyard/eliza_rocket`
  are useful audit inputs, but they are not chip Linux boot evidence by
  themselves.
- `import-manifest.template.json` is copied into
  `build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json` by the
  eventual generator/import flow, then filled with recursive submodule SHAs,
  command lines, tool versions, the passing bootstrap and Verilator preflight
  reports, artifact paths, artifact SHA-256 values, evidence paths, and evidence
  SHA-256 values.
- `docs/evidence/cpu-ap-evidence-manifest.json` is the fail-closed schema for
  generated artifact paths and required OpenSBI/Linux/trap transcript markers.
  Its `linux_capable_gate_matrix` keeps RV64GC ISA, S-mode privilege, Sv39 MMU,
  CLINT/ACLINT timer/software IRQ, PLIC external IRQ, UART, DTB, OpenSBI
  handoff, and Linux initramfs smoke gates in `blocked` state until real
  generated-target evidence is archived.
- `scripts/run_qemu.sh --check-os` writes
  `build/reports/qemu_os_boot_attempt.log` with `BLOCKED`, `FAIL`, or `PASS`.
  That log is software-reference evidence only; it cannot close any
  Chipyard/Rocket AP Linux-capable gate.
- `scripts/run_renode.sh --check` is separate Renode reference-model evidence.
  It is not QEMU evidence, and it is not generated ElizaRocketConfig
  Linux/OpenSBI proof unless a real generated e1-chip Renode model and
  transcript gate are added.
- `make chipyard-generated-ap-boot` runs
  `scripts/run_chipyard_eliza_linux_smoke.sh`, which appends wrapper
  metadata and a bounded timeout result to
  `build/chipyard/eliza_rocket/verilator-linux-smoke.log`. That log still
  passes only when `scripts/check_chipyard_verilator_linux_smoke.py` finds
  OpenSBI and Linux markers from the generated AP simulator.
- `scripts/check_chipyard_generated_linux_contract.py` audits any generated
  DTS, memmap, and regmaps that are present. It may pass the structural Linux
  node check while still reporting boot evidence as `BLOCKED`.
- `scripts/check_chipyard_payload_path.py` is the next payload-path gate. It
  checks the generated DTS/artifacts and then reports the missing OpenSBI,
  U-Boot, Linux boot, trap/IRQ, and ISA/MMU evidence needed before any
  generated-target boot claim. QEMU `virt` Debian payload logs remain
  software-reference evidence only and do not close this gate.

## First Integration Target

```text
ElizaRocketConfig
1x Rocket RV64GC hart
CLINT/ACLINT-compatible mtime, mtimecmp, and msip
PLIC-compatible external interrupts
UART for firmware and Linux early console
DRAM model sized for OpenSBI + Linux initramfs smoke
e1 DMA/NPU/display/peripheral MMIO attachment points
generated DTS checked against the platform contract
```
