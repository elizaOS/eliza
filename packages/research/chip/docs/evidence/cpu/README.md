# CPU/AP Evidence Capture

This directory documents CPU/AP evidence expectations. Linux-capable AP evidence
for the generated Chipyard `ElizaRocketConfig` target is archived under
`build/evidence/cpu_ap/`, not committed here.

QEMU `virt` boot logs are software-reference evidence only. They do not satisfy
the generated AP OpenSBI/Linux/trap/cache/benchmark gates.

Required generated-target evidence paths:

- `build/evidence/cpu_ap/eliza_e1_opensbi_boot.log`
- `build/evidence/cpu_ap/eliza_e1_linux_boot.log`
- `build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log`
- `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log`
- `build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log`

Use these commands to see the marker checklist, archive real generated-AP logs,
and check the result:

```sh
python3 scripts/capture_cpu_ap_evidence.py template all
python3 scripts/capture_cpu_ap_evidence.py plan all --format shell
python3 scripts/wire_cpu_ap_capture_commands.py --format shell
scripts/capture_chipyard_linux_evidence.sh --help
scripts/capture_chipyard_linux_evidence.sh preflight
python3 scripts/check_cpu_ap_evidence.py --require-evidence
python3 scripts/check_chipyard_generated_linux_contract.py --require-boot-evidence
```

The capture wrapper requires one command environment variable per transcript.
Each command must run the generated AP simulator or generated-target test and
print the real transcript to stdout/stderr. The wrapper keeps raw output in
`build/evidence/cpu_ap/raw/` and only writes accepted evidence after the intake
validator sees the required markers and binds the transcript to
`build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json`.

## Pass criteria

A generated AP evidence set must show all of the following across the accepted
logs:

1. OpenSBI reset, CSR, timer, interrupt-controller, UART, DRAM, and next-stage
   handoff markers.
2. Linux early console, generated DTS hash, DT boot nodes, exact
   `Linux CONFIG_MMU: CONFIG_MMU=y`, kernel command line, initramfs start, and
   e1 MMIO smoke result markers.
3. Trap, timer, software IRQ, PLIC external IRQ claim/complete, `mret`, and
   `sret` markers.
4. RV64GC, `misa`, exact `Linux CONFIG_MMU: CONFIG_MMU=y`, successful
   `riscv_hwprobe: syscall rc=0`, `riscv_hwprobe: key=mvendorid`,
   `riscv_hwprobe: key=marchid`, `riscv_hwprobe: key=ima_ext_0`, `Zicsr`,
   `Zifencei`, Sv39, cache, TLB, and page-table markers.
5. Benchmark report hash, CoreMark/MHz, STREAM Triad, `lat_mem_rd`, `fio`, CPU
   frequency, run count, thermal state, and power method markers.

The ISA/cache/MMU lane stays blocked until the accepted generated-AP Linux
userspace transcript at `build/evidence/cpu_ap/eliza_e1_linux_boot.log` passes
the manifest checks and contains the real hwprobe helper success marker
`riscv_hwprobe: syscall rc=0`, the exact `Linux CONFIG_MMU: CONFIG_MMU=y`
marker, and the required hwprobe key markers (`mvendorid`, `marchid`, and
`ima_ext_0`). Bare-metal ISA/cache/MMU output, live smoke-log diagnostics,
helper packaging, or failed helper output such as
`riscv_hwprobe: FAIL ...` is not sufficient to export `ELIZA_ISA_CACHE_MMU_CMD`
or archive `build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log`.

## Linux Host Flow

On the Linux host, first generate/build the pinned Chipyard target and create
`build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json`. Then
derive the command variables that can be backed by checked-in generated-AP
runners:

```sh
python3 scripts/wire_cpu_ap_capture_commands.py --format text
eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)"
scripts/capture_chipyard_linux_evidence.sh preflight
```

The generated wiring exports `ELIZA_OPENSBI_BOOT_CMD` and
`ELIZA_LINUX_BOOT_CMD` from the real
`scripts/run_chipyard_eliza_linux_smoke.sh` path when the generated
manifest and FireMarshal payload are present. It exports
`ELIZA_TRAP_TIMER_IRQ_CMD` when the generated trap/timer/IRQ runner is
available. `ELIZA_ISA_CACHE_MMU_CMD` and `ELIZA_AP_BENCHMARKS_CMD` remain
blocked until the accepted generated-AP Linux userspace transcript passes
`linux-boot` intake for the active generated manifest. Do not replace those
with marker echo scripts, copied reference logs, or edited transcripts.

The two boot captures may use the same simulator command if one full boot log
contains all OpenSBI and Linux markers. Trap/cache/benchmark captures should
point at generated-target tests or scripts that emit those specific results.
Do not edit raw transcripts to make the intake pass; fix the simulator payload
or test command and rerun the capture.

Before starting a long simulator run, use the capture plan and preflight to
confirm that all five command lanes are wired:

```sh
python3 scripts/capture_cpu_ap_evidence.py plan all --format shell
scripts/capture_chipyard_linux_evidence.sh preflight
```

`preflight` does not run the simulator or create evidence. It checks that
`build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json` exists
and that every `ELIZA_*_CMD` variable is set.

After all captures pass, copy the printed `artifact_sha256.*` and
`evidence_sha256.*` values from `python3 scripts/capture_cpu_ap_evidence.py
hashes` into the generated import manifest, then rerun the checks above.

## After Linux Boot Intake

When `linux-boot` intake passes, the intake helper mirrors the accepted
CPU/AP boot evidence into the Linux docs evidence artifacts used by
`minimum-linux-target`. You can rerun the mirror explicitly without touching
the simulator:

```sh
python3 scripts/capture_cpu_ap_evidence.py sync-linux-docs linux
```

Then derive the now-unblocked commands and capture the remaining dependent
lanes:

```sh
python3 scripts/capture_cpu_ap_evidence.py sync-linux-docs linux
scripts/build_firemarshal_eliza_ap_benchmarks_payload.sh
eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)"
scripts/capture_chipyard_linux_evidence.sh remaining-after-linux-boot
python3 scripts/capture_cpu_ap_evidence.py hashes
python3 scripts/check_cpu_ap_evidence.py --require-evidence
python3 scripts/check_minimum_linux_target.py --strict
python3 scripts/check_minimum_linux_npu_target.py --strict
```

The AP benchmark payload builder writes
`external/chipyard/software/firemarshal/images/firechip/eliza-e1-ap-benchmarks/payload_freshness_manifest.json`.
`wire_cpu_ap_capture_commands.py` will not export `ELIZA_AP_BENCHMARKS_CMD`
unless that sidecar matches the current AP benchmark workload, kfrag, wrapper,
target binaries, no-disk payload, current generated manifest, and accepted
`linux-boot` evidence. The sidecar must be generated after the accepted
`build/evidence/cpu_ap/eliza_e1_linux_boot.log` `intake_utc`, and
`ap-benchmarks` intake rejects source transcripts whose mtime predates that
Linux intake. Rebuild the AP benchmark payload and rerun
`scripts/capture_chipyard_linux_evidence.sh ap-benchmarks` after every new
accepted `linux-boot` intake.
