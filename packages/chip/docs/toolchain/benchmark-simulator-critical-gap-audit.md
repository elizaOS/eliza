# Benchmark, Toolchain, and Simulator Critical Gap Audit

Date: 2026-05-17

Scope: `benchmarks/**`, `sim/**`, `scripts/check_tools.sh`, `scripts/run_qemu.sh`,
`scripts/run_renode.sh`, `Dockerfile`, `flake.nix`, and `docs/toolchain/**`.

## Status Terms

| Status | Meaning | Strict gate behavior |
| --- | --- | --- |
| `PASS` | The required source, tool, artifact, and transcript exist for the named gate. | Exit 0. |
| `BLOCK` / `BLOCKED` | The repo scaffold is coherent, but external tools, generated assets, or run evidence are absent. | Non-strict status checks may exit 0; strict checks must exit 2 or fail the caller. |
| `FAIL` | A checked-in file, semantic contract, schema, build, or executable run is wrong. | Exit non-zero in all modes. |
| `planned_missing_deps` | Benchmark dry-run command is valid, but one or more executable dependencies are absent. | `--strict-missing` exits 2. |
| `blocked` | Benchmark dry-run or run is blocked by release-visible model/data assets. | `--strict-missing` exits 2. |

Machine-readable status sources now include:

- `scripts/check_tools.sh --json`, schema `eliza.tool_status.v1`.
- `benchmarks/run_benchmarks.py plan|run`, schema `eliza.benchmark_run.v1`.
- `scripts/run_qemu.sh --check`, `STATUS: PASS|BLOCKED|FAIL qemu.*` stage lines.
- `scripts/run_renode.sh --check`, `STATUS: PASS|BLOCKED|FAIL renode.*` stage lines.

## Missing Benchmark Tools and Assets

| Benchmark | Missing tools/assets | Current machine status | Required unblock |
| --- | --- | --- | --- |
| CoreMark | Phone-class target compiler flags, target clock and affinity metadata, L5/L6 raw-output hash. | `passed` as CVA6 Verilator L1 RTL evidence; still blocked for phone-class claims. | Run on real prototype/phone target with pinned build recipe, target metadata, and archived raw output before using scores for L5/L6 claims. |
| STREAM | `stream_c.exe`; array size policy; compiler flags; thread/affinity policy; memory clock evidence. | `planned_missing_deps` when `stream_c.exe` is absent. | Add fixed build flags and run metadata before using scores. |
| lmbench bandwidth | Real target metadata, calibration assets, power/clock/memory/process evidence. | Tool binary can be found locally, but the phone report is `blocked` until L5/L6 metadata and calibration requirements are satisfied. | Run target-built `bw_mem` on real prototype/phone target and archive raw stdout plus parsed metric. |
| lmbench latency | Real target metadata, calibration assets, power/clock/memory/process evidence. | Tool binary can be found locally, but the phone report is `blocked` until L5/L6 metadata and calibration requirements are satisfied. | Run target-built `lat_mem_rd` on real prototype/phone target and archive stride sweep output. |
| fio sequential read | `fio`; target filesystem/device identity; JSON parser and config are present. | `planned_missing_deps` when `fio` is absent. | Install target fio, run the JSON-output config on the target, and record target storage topology. |
| fio random read/write | `fio`; target filesystem/device identity; JSON parser and config are present. | `planned_missing_deps` when `fio` is absent. | Same as sequential read; include random workload parameters in report metadata. |
| TFLite CPU | Real `benchmark_model`; `benchmarks/models/mobile_smoke.tflite`; pinned model SHA-256. | `planned` when the real binary and pinned model are present; `blocked` if either falls back to a host-smoke shim, missing binary, or missing/placeholder model. | Archive benchmark_model build provenance and target run metadata before using scores for release claims. |
| TFLite e1 NPU | Real `benchmark_model` with NNAPI; `mobile_smoke.tflite`; real `e1-npu` NNAPI delegate/accelerator proof. | `blocked` until `benchmarks/capabilities/e1_npu_nnapi.proof.json` and its required transcripts are captured from hardware. | Add NNAPI delegate evidence, accelerator name validation, DMA transcript, and zero-fallback parser evidence. |
| MLPerf Mobile | External checkout, APK/runner, datasets, Android target, device shell path. | Documentation only; not represented in `benchmark_plan.json`. | Add an external-run manifest before accepting MLPerf numbers. |

The benchmark harness correctly refuses to mark a result `passed` if required
executables are missing or model artifacts are unavailable. The remaining gap is
metric quality: the configs plan commands and dependency checks, but do not yet
pin build recipes, parsers, target thermal/power context, or sustained-run
metadata.

## Fake and Fallback Simulator Paths

| Area | Current behavior | Risk | Required unblock |
| --- | --- | --- | --- |
| QEMU target | `scripts/run_qemu.sh` builds and runs a qemu-virt RISC-V firmware, not e1-chip hardware. | A qemu-virt serial banner can be mistaken for e1-chip boot evidence. | Keep docs and status lines saying `software reference only`; archive the ELF and transcript only as software-reference evidence. |
| QEMU non-strict check | Missing RISC-V compiler or `qemu-system-riscv64` reports `BLOCKED` and exits 0 unless `REQUIRE_QEMU=1`. | CI smoke can stay green while executable QEMU evidence is absent. | Use `make qemu-check-strict` for release gates. |
| QEMU fake test path | `scripts/test_qemu_smoke_status.py` injects fake compiler/QEMU binaries to test status handling. | Fake PASS could be misread as simulator evidence if logs are reused. | Treat it only as unit coverage for status transitions; never archive it as boot proof. |
| Renode scaffold | `sim/renode/eliza_e1.repl` and `.resc` model the qemu-virt memory/UART map. | It is not a real e1 hardware model and the interactive `.resc` is not boot evidence by itself. | Add a bounded transcript capture and hardware-map model before using Renode as boot evidence. |
| Renode non-strict check | Missing `renode`, missing firmware, or missing real transcript intake reports `BLOCKED` and exits 0 unless `REQUIRE_RENODE=1`; `scripts/run_renode.sh --check --transcript PATH` only passes after archiving a transcript containing the expected banner. | Smoke can pass only with semantic scaffold coverage plus an explicitly supplied transcript; the transcript still must come from a real Renode run. | Use `make renode-check-strict` for release gates and archive `build/reports/renode_smoke.manifest` with any real transcript evidence. |
| Verilator/cocotb fallback | RTL tests are real fast-path checks, but they do not validate QEMU/Renode software boot. | Passing RTL smoke can be overclaimed as system software readiness. | Keep software/simulator claims tied to their own status artifacts. |

## Strict vs Non-Strict Gates

| Gate | Non-strict behavior | Strict behavior |
| --- | --- | --- |
| `scripts/check_tools.sh` | Prints `PASS`, `BLOCK`, and `FAIL`; exits 0 unless required fast-path tools/packages are missing and `--strict` is set. | `scripts/check_tools.sh --strict` exits 1 on missing required fast-path tools or Python packages. |
| `scripts/check_tools.sh --json` | Emits `eliza.tool_status.v1` with per-tool `status`, `tier`, `gate`, `required`, and `path_or_status`. | Combine with `--strict` to preserve the same exit policy. |
| `benchmarks/run_benchmarks.py plan` / `--dry-run` | Writes a dry-run report with `planned`, `planned_missing_deps`, or `blocked`. | `--strict-missing` exits 2 when any dependency or release-blocking asset is absent. |
| `benchmarks/run_benchmarks.py run` | Skips blocked/missing workloads by recording `blocked` or `missing_dependencies`; real command failures exit 1. | `--strict-missing` exits 2 for missing deps/assets and 1 for real failures. |
| `make cpu-phone-l5-l6-benchmark-report` | Writes `build/reports/cpu_phone_l5_l6_benchmark_report.json`, a unified SPEC/CoreMark/Dhrystone/JetStream/lmbench L5/L6 evidence matrix. Blocked evidence exits 0 so reviewers can inspect the matrix. | `make cpu-phone-benchmark-claim-gate-strict` exits 2 while any required phone-class benchmark entry is blocked, below L5/L6, missing raw hashes, missing metrics, or not measured. |
| `make benchmarks-local-host-evidence` | Runs locally installed CoreMark, STREAM, lmbench, fio, and TFLite CPU tools, archives raw logs, and parses metrics. | Writes non-release host evidence only; it is not target silicon, AOSP, PDK, power, or thermal evidence. |
| `make qemu-check` | Semantic failures fail; missing compiler/QEMU is `BLOCKED` and exits 0. | `make qemu-check-strict` sets `REQUIRE_QEMU=1` and exits 2 on blocked executable smoke. |
| `make renode-check` | Semantic failures fail; missing Renode/firmware/real transcript intake is `BLOCKED` and exits 0. | `make renode-check-strict` sets `REQUIRE_RENODE=1` and exits 2 on blocked executable smoke. |
| `make smoke` | Includes non-strict QEMU/Renode and benchmark dry-run checks. | Not a release evidence gate. |

## Missing Reproducibility Dependencies

| Component | Gap | Risk | Required unblock |
| --- | --- | --- | --- |
| Docker base | `ubuntu:24.04` is a moving tag and apt package versions are not frozen. | Rebuilding later can change Verilator/Yosys/QEMU/compiler behavior. | Pin base image digest and archive apt package manifest. |
| Docker benchmark stack | Fast image omits fio, lmbench, CoreMark, STREAM, TFLite `benchmark_model`, Renode, OpenLane, Magic, Netgen, KiCad CLI, OpenOCD, and sigrok. | Tool inventory may show benchmark and heavy flow blocks on a clean Docker path. | Add a separate benchmark/heavy image or document target-rootfs installation manifests. |
| Python requirements | `requirements.txt` is bounded but not hash-locked. | Local and container Python packages can drift. | Add lock/constraints with hashes for accepted evidence paths. |
| Nix | `nixos-unstable` floats and `flake.lock` is absent. | `nix develop` is not reproducible. | Run and commit `nix flake lock` once Nix is a supported gate. |
| OpenLane2 bootstrap | Script clones default branch under `external/openlane2`. | PD evidence can change without repo changes. | Pin tag/SHA and recursive dependency manifest. |
| Chipyard bootstrap | Script clones default branch under `external/chipyard`. | Generator evidence can drift. | Pin release/SHA plus submodule manifest. |
| OSS CAD Suite | Local path discovery only; no archive URL/checksum. | Host fallback versions are not replayable. | Pin release URL and checksum if used as canonical host toolchain. |
| QEMU firmware toolchain | `riscv64-unknown-elf-gcc`, `riscv64-elf-gcc`, or `riscv64-linux-gnu-gcc` is accepted. | Different compilers can produce different ELF behavior. | Record compiler path/version and archive built ELF hash. |
| Renode | Local `renode` from `PATH`; no version pin. | Transcript behavior can vary across installs. | Record version and use a pinned install path for release. |
| Benchmark models | `mobile_smoke.tflite` is present with a pinned SHA-256 in `benchmark_plan.json`. | TFLite runs still need target-side `benchmark_model` provenance and hardware transcripts before release claims. | Keep the model hash pinned and archive target runner/build metadata with each report. |

## GUI and Non-CLI Risks

| Tool/flow | CLI status | Risk | Mitigation |
| --- | --- | --- | --- |
| KiCad | `kicad-cli` is discoverable, but no project exists. | Manual schematic/PCB GUI work could be claimed without exported artifacts. | Require `kicad-cli` ERC/DRC/plot/export once a `.kicad_pro` is checked in. |
| GTKWave | GUI-oriented optional debug tool. | Waveform review is not reproducible as evidence. | Treat `gtkwave` as debug only; archive simulator logs and VCD/FST files instead. |
| Docker Desktop on macOS | CLI can drive builds, daemon is host-managed. | GUI daemon state or missing engine can block headless runs. | Record Docker CLI/daemon versions and image digest. |
| AOSP/Cuttlefish | Mostly CLI, but host KVM/device services are external. | AOSP boot proof can depend on host setup not captured in repo. | Add transcript parsers for `lunch`, build, and first boot once checkout exists. |
| OpenLane/OpenROAD/KLayout/Magic | Headless-capable, but often inspected through GUI locally. | Visual signoff can bypass repo artifacts. | Require report/GDS/DEF/DRC/LVS manifests from CLI runs only. |
| OpenOCD/sigrok | CLI-capable but no board profile exists. | Manual probe sessions are not replayable. | Add board config and capture scripts before using lab evidence. |
| FreeCAD/mechanical | `FreeCADCmd` exists but no model is checked in. | GUI-only mechanical edits are invisible to CI. | Require command-line export/check scripts once mechanical models exist. |

## Required Follow-Up Checks

1. Add benchmark JSON parsers for fio, CoreMark, STREAM, lmbench, and TFLite output.
2. Archive build recipes and version capture for CoreMark, STREAM, lmbench, fio, and `benchmark_model`; keep local-host runs separated from release evidence with `make benchmarks-local-host-evidence`.
3. Pin Docker/Nix/OpenLane/Chipyard inputs before using their outputs as release evidence.
4. Archive QEMU/Renode transcripts under `build/reports/` only when they come from real tools, not fake status tests.
