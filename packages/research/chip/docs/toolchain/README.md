# Toolchain setup

The project uses two tool tiers:

1. Fast e1-chip tools in `Dockerfile` and `flake.nix`.
2. Heavy SoC/PD/software stacks bootstrapped under `external/` only when needed.

## Local validation entry points

Run these before claiming tool reproducibility:

```sh
scripts/check_tools.sh
scripts/tool_versions.sh
```

`scripts/check_tools.sh` is a read-only inventory. It reports each tool as
`fast`, `host`, or `heavy`, names the gate that consumes it, and records whether
the repo-local `.venv` exists. Use `scripts/check_tools.sh --strict` when a
worker needs missing fast-path Python packages to fail the command.

`scripts/tool_versions.sh` writes `build/reports/tool_versions.txt` with command
paths, first-line version strings, selected Python environment, Python package
versions, and SHA-256 hashes for `requirements.txt`, `Dockerfile`, and
`flake.nix`.

The benchmark and simulator critical-gap inventory is maintained in
`docs/toolchain/benchmark-simulator-critical-gap-audit.md`. It enumerates
missing benchmark tools/assets, fake or fallback simulator paths, strict versus
non-strict gate behavior, reproducibility dependencies, and GUI/non-CLI risks.

## Python environment policy

The reproducible local path is a repo-owned virtualenv:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Do not rely on the user Python site for evidence. User-site packages are allowed
only as a temporary unblocker and must be called out in validation notes. The
Docker image uses `/opt/eliza-venv` for the same reason: cocotb, pytest,
NumPy, and PyYAML should not perturb the host Python installation.

## Fast default image

```sh
docker build -t eliza-soc-tools .
docker run --rm -it -v "$PWD:/work" -w /work eliza-soc-tools make smoke cocotb verilator formal
```

This image currently installs:

```text
Verilator
Yosys
Yosys SMTBMC
Z3
Icarus Verilog
GTKWave
QEMU RISC-V system emulator
Python
cocotb
pytest
numpy
PyYAML
```

## Heavy external stacks

The following tools are intentionally not vendored into the fast image:

| Tool | Bootstrap entry point | Why separate |
| --- | --- | --- |
| Chipyard | `scripts/bootstrap_chipyard.sh` | Large recursive submodule stack |
| Chisel/CIRCT | Chipyard plus `generators/chisel`/`generators/circt` | JVM/LLVM-heavy generator flow |
| OpenLane/OpenROAD full PD | `scripts/bootstrap_librelane.sh` and `make openlane` | PDK and container-specific flow |
| SymbiYosys | local package/Nix install; `.sby` files are present | Solver packaging varies by OS; Docker carries Z3 for the Yosys fallback |
| Renode | local install; `make renode` uses stubs | Not packaged in the fast image |
| AOSP | future `sw/aosp-device` target | Too large for normal chip CI |

## Pinning status

| Component | Current state | Reproducibility action |
| --- | --- | --- |
| `requirements.txt` | Version ranges are bounded but not hash-locked. | Generate a lock/constraints file after the `.venv` baseline is accepted. |
| Docker base image | `ubuntu:24.04` is a moving tag plus apt package versions. | Pin by digest for release archives; include `tool_versions.sh` output with every archive. |
| Nix | `nixos-unstable` floats and no `flake.lock` is present. | Run `nix flake lock` when Nix becomes an accepted gate; commit `flake.lock`. |
| OpenLane image | `ghcr.io/efabless/openlane2:2.4.0.dev1`; Linux arm64 manifest digest `sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5`. | Keep `OPENLANE_IMAGE_DIGEST` pinned in install/preflight scripts before claiming PD reproducibility. |
| OpenLane2 bootstrap | `git clone` default branch in `external/openlane2`. | Replace with a reviewed tag/SHA and checksum or submodule manifest. |
| Chipyard bootstrap | `git clone` default branch in `external/chipyard`. | Replace with a selected release/SHA and recursive submodule manifest. |
| OSS CAD Suite | Local install path only; no archive ref. | Pin release URL and checksum if it becomes the canonical host toolchain. |

## Current verified path

The default Docker path has been verified through:

```text
docs-check
Verilator lint/elaboration
Yosys synthesis
cocotb register tests
standalone Verilator C++ smoke
Yosys SAT formal fallback
```

OpenLane/OpenROAD targets are wired, but require a local/container OpenLane installation plus an installed PDK.

## Docker vs host gaps

The fast Docker image is the CI baseline for smoke and normal RTL evidence. It
is intentionally smaller than a full host workstation and does not prove that
every optional flow is installed.

| Area | Docker expectation | Host expectation | Gate behavior |
| --- | --- | --- | --- |
| cocotb | Installed through `requirements.txt`; `make cocotb` and `make cocotb-contract` should run with Verilator. | Use the same Python requirements in a virtualenv or Nix shell, plus a compatible Verilator on `PATH`. | Missing cocotb is a hard failure for CI paths that request cocotb. |
| SymbiYosys | Not required in the fast image; Yosys/Z3 are present for the formal fallback scripts. | Install `sby` plus solvers locally when `.sby` proof evidence is required. | `make formal` may use fallback evidence; `make ci-strict` sets `REQUIRE_SBY=1` and requires SymbiYosys. |
| FPGA place/route | `make fpga-check` validates scaffold metadata only. | Install `nextpnr-ecp5` and `ecppack` before attempting bitstreams. | Bitstream release stays blocked while FPGA pins and board revision are unassigned. |
| Android/AOSP | BSP and device-tree consistency checks only. | Full AOSP checkout, riscv64/Cuttlefish dependencies, and host-side CTS/VTS tools. | `make aosp-bsp-check` validates repo artifacts; it is not an Android boot proof. |
| Benchmarks | Schema and matrix checks only. | Install workload tools such as CoreMark, STREAM, lmbench, fio, TFLite benchmark, CTS/VTS, and Perfetto. | Reports must use `docs/benchmarks/report-schema.yaml` and must not compare simulator wall-clock time with phone scores. |

## CLI/headless audit matrix

Every tool below was audited for Codex-friendly, GUI-free operation. "Install
path" names the command path that `scripts/check_tools.sh` and
`scripts/tool_versions.sh` try to discover, not a bundled dependency.

| Tool | Command-line entrypoint | Install path | Current repo command | GUI-free status | Missing dependencies / blockers | Next automation step |
| --- | --- | --- | --- | --- | --- | --- |
| KiCad / `kicad-cli` | `kicad-cli` | `PATH`, `/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli`, distro package, or Homebrew cask | No make target; only `docs/board/kicad/e1-demo/fab-notes.md` placeholder is referenced | Headless-capable for ERC/DRC/plot/export once a real project exists | No checked-in `.kicad_pro`, schematic, PCB, or fab outputs | Add a `scripts/check_kicad_project.sh` gate after package pins and board revision are assigned. |
| Yosys | `yosys`, `yosys-smtbmc` | Docker apt, Nix shell, OSS CAD Suite, or `PATH` | `make synth`, `scripts/run_yosys.sh`; fallback formal in `scripts/run_formal.sh` | Headless-ready and part of smoke when installed | Optional locally; release evidence needs exact version and input hashes | Keep synthesis/formal logs under `build/reports` and pin OSS CAD Suite or Docker inputs. |
| Verilator | `verilator` | Docker apt, Nix shell, OSS CAD Suite, or `PATH` | `make rtl-check`, `make verilator`, cocotb via `scripts/run_cocotb.sh` | Headless-ready and part of fast RTL evidence | Optional locally; cocotb prefers Verilator and falls back to Icarus | Archive lint/elaboration logs and promote version capture into release manifest. |
| cocotb | `cocotb-config`, Python import `cocotb` | repo `.venv/bin`, Docker `/opt/eliza-venv/bin`, Nix Python env, or user `PATH` | `make cocotb`, `make cocotb-contract`, `make cocotb-cpu` | Headless-ready through make and simulator backends | Repo-local `.venv` may be missing; needs Verilator or Icarus | Make `.venv` the default local evidence path and archive `results.xml`. |
| SymbiYosys | `sby` | Nix, OSS CAD Suite, distro package, or `PATH` | `make formal`; `make ci-strict` sets `REQUIRE_SBY=1` | Headless-ready | Not required by fast Docker; requires solver stack (`z3`/`boolector`) and `.sby` support | Add strict formal transcript capture once `sby` is pinned. |
| OpenROAD | `openroad` | OpenLane container, OpenROAD build, Nix/OSS CAD Suite where available, or `PATH` | `make openroad`, `scripts/run_openroad.sh` | Headless-ready through Tcl | Missing local install/PDK in normal smoke | Add preflight that records PDK root, OpenROAD version, and output report list before signoff. |
| OpenLane | `openlane`, legacy `flow.tcl`, or `docker run ... openlane` | `PATH` or pinned Docker image `ghcr.io/efabless/openlane2:2.4.0.dev1` | `make openlane`, `scripts/run_openlane.sh`, `scripts/install_openlane_image.sh` | Headless-ready through CLI/container | Requires Docker or OpenLane install, PDK, Magic, Netgen, OpenROAD, and real run artifacts | Replace floating bootstrap clone with a pinned OpenLane2 ref and capture image digest per run. |
| MVP status report | `python3 scripts/check_mvp_status.py` | Repo Python | `make mvp-status`, `make mvp-status-strict` | Headless-ready; emits one `PASS`, `BLOCK`, or `FAIL` row per subsystem with evidence and next command | `--strict` exits non-zero for any block; default mode is a readable gap report | Keep new subsystem checks wired into this report before marking workstream gates complete. |
| QEMU | `qemu-system-riscv64` | Docker apt, Nix shell, distro package, or `PATH` | `make qemu`, `make qemu-check`, `scripts/run_qemu.sh --check` | Headless-ready with `-nographic`; reports `STATUS: PASS`, `STATUS: BLOCKED`, or `STATUS: FAIL` per stage | Executable smoke also needs a RISC-V ELF compiler for `e1_qemu_firmware.S` | Add CI artifact for the built ELF and bounded serial transcript. |
| Renode | `renode` | `PATH` from an official Renode install | `make renode`, `scripts/run_renode.sh --check`, `scripts/run_renode.sh --check --transcript PATH`, `make renode-check` | CLI-capable; check mode reports `BLOCKED` when Renode, firmware, or a real transcript is absent unless `REQUIRE_RENODE=1`; transcript intake archives `build/reports/renode_smoke.log` only after the expected banner is found | No real e1 hardware model; only qemu-virt reference `.repl/.resc` exists | Automate bounded Renode console capture and keep release claims tied to the archived transcript manifest. |
| Renode | `renode` | `PATH` from local Renode install | `make renode`, `scripts/run_renode.sh --check`, `make renode-check` | CLI-capable; check mode reports `BLOCKED` when Renode is absent unless `REQUIRE_RENODE=1` | No real e1 hardware model; only qemu-virt reference `.repl/.resc` exists | Add a bounded console transcript check after the model is upgraded. |
| Buildroot | external `make` in a Buildroot checkout | External Buildroot tree plus host `make`, `rsync`, compiler toolchain | `make buildroot-check`; external commands documented in `docs/sw/buildroot/README.md` | Headless-ready in external tree | Buildroot source is not vendored; no kernel/rootfs build is run in repo | Add a dry-run import checker that validates `BR2_EXTERNAL` wiring against a provided checkout. |
| Linux kernel | external `make ARCH=riscv ...` | External Linux tree plus `make`, `dtc`, `bc`, `flex`, `bison`, cross compiler | `make linux-bsp-check`; external import helper in `sw/linux/scripts/import-linux-bsp.sh` | Headless-ready in external tree | Kernel source is not vendored; drivers/DTS are not compiled by repo checks | Add optional compile smoke for modules and DTS when `LINUX_TREE` is set. |
| AOSP / Cuttlefish | `repo`, `source build/envsetup.sh`, `lunch`, `m`, `cvd`/`launch_cvd` | External AOSP checkout on Linux host with KVM/Cuttlefish | `make aosp-bsp-check`; external import helper in `sw/aosp-device/import-aosp-device.sh` | Mostly headless; AOSP build and Cuttlefish launch are CLI-driven | AOSP checkout, Java/build deps, KVM/Cuttlefish, kernel artifact, and HAL binaries are absent | Add transcript parser for `lunch`, `m vendorimage`, and first Cuttlefish boot once an external checkout exists. |
| fio | `fio` | Target/rootfs `PATH` or host package for board/dev-board runs | `make benchmarks-dry-run`; planned commands in `benchmarks/configs/benchmark_plan.json` | Headless-ready | Tool is optional; benchmark reports must not upgrade claim level without platform evidence | Add parsers for JSON output and require `--output-format=json` in benchmark configs. |
| lmbench | `bw_mem`, `lat_mem_rd` | Target/rootfs `PATH` or locally built lmbench binaries | `make benchmarks-dry-run` | Headless-ready | lmbench binaries are not bundled | Add artifact capture for raw stdout and parsed bandwidth/latency fields. |
| CoreMark | `coremark` | Target/rootfs `PATH` or locally built CoreMark binary | `make benchmarks-dry-run` | Headless-ready | Binary and compiler flags are not pinned | Add build recipe with fixed flags and require compiler/version metadata. |
| STREAM | `stream_c.exe` | Target/rootfs `PATH` or locally built STREAM binary | `make benchmarks-dry-run` | Headless-ready | Binary, array size, compiler, and affinity policy are not pinned | Add build recipe and record array size, threads, compiler flags, and memory clock evidence. |
| TFLite `benchmark_model` | `benchmark_model` | Target/rootfs `PATH`, Android device shell, or TensorFlow Lite build output | `make benchmarks-dry-run` plans `benchmark_model` commands | Headless-ready | `benchmarks/models/mobile_smoke.tflite` is present and pinned; target binary/delegate provenance is absent | Archive target `benchmark_model` build metadata, delegate proof, and parser output before using scores. |
| MLPerf Mobile | MLPerf app/runner commands, usually Android-device driven | External MLPerf Mobile checkout and Android target/device | Documentation only in benchmark matrix | Mostly headless after device/app setup; not repo-local today | No MLPerf checkout, APK, datasets, or device runner | Add an external-run manifest format before accepting MLPerf numbers. |
| OpenOCD / sigrok | `openocd`, `sigrok-cli` | Host `PATH` packages or vendor probe tools | Not referenced by current repo commands | Headless-capable | No board debug probe, pin map, or capture scripts are checked in | Defer until board-smoke owns probe wiring; add checks only when referenced by a board gate. |
| Docker | `docker` | Host Docker Desktop/Engine | `docker build ...`, `docker run ... make smoke`, OpenLane image path | Headless-capable via CLI, although Docker Desktop is host-managed on macOS | Base image and apt packages float; daemon/image may be absent | Pin base image digest and archive package manifest plus image digest. |
| Nix | `nix develop` | Host Nix install | Optional developer shell from `flake.nix` | Headless-ready | No `flake.lock`; nixpkgs floats | Run `nix flake lock` once Nix becomes a supported release evidence path. |

## Upstream and fork strategy

Default to upstream releases, tags, image digests, and checksums. Do not vendor
or fork Chipyard, OpenLane/OpenROAD, PDKs, AOSP, Renode, KiCad, or OSS CAD Suite
to hide reproducibility gaps.

Fork only when an unavoidable local patch blocks a named release gate. A fork
must include the upstream base SHA, the smallest patch branch, the gate it
unblocks, and an upstreaming or retirement plan. No fork should become the
default path until `scripts/tool_versions.sh` records the exact ref used for
the evidence package.

## Explicit blockers

| Blocker | Affected gate | Required unblock |
| --- | --- | --- |
| Missing repo-local `.venv` | local cocotb/docs/project-plan evidence | Create `.venv` and install `requirements.txt`. |
| Floating Docker apt inputs | release-grade Docker evidence | Pin base image digest or archive full package manifest. |
| Missing `flake.lock` | Nix reproducibility | Lock nixpkgs and record supported systems. |
| Floating OpenLane2/Chipyard clones | PD/generator reproducibility | Select tags/SHAs and capture recursive manifests. |
| Missing OpenROAD/OpenLane/Magic/Netgen locally | `make openroad`, `make openlane`, signoff | Install pinned PD flow and PDK, then archive reports. |
| Missing Renode model evidence | `make renode-check` as boot proof | Add a hardware-map model and command transcript. |
| Missing board/package pins | FPGA bitstream and board release | Assign exact pins, IO standards, board revision, and SI/PI evidence. |

## OpenLane image

The configured OpenLane2 image is:

```sh
OPENLANE_IMAGE=ghcr.io/efabless/openlane2:2.4.0.dev1
OPENLANE_IMAGE_DIGEST=sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5
scripts/install_openlane_image.sh
```

Then run:

```sh
OPENLANE_TIMEOUT_SECONDS=21600 OPENLANE_CONFIG=pd/openlane/config.sky130.json make openlane
```

If the image is unavailable or the registry stalls, `make openlane` fails clearly rather than pretending signoff completed. The exact preflight sequence is:

```sh
make pd-contract-check
OPENLANE_IMAGE=ghcr.io/efabless/openlane2:2.4.0.dev1 OPENLANE_IMAGE_DIGEST=sha256:bcaabac3b114dfb9e739af9f16b53a79ce1b744bcdb3ad4fc476c961581fe5d5 scripts/install_openlane_image.sh
OPENLANE_TIMEOUT_SECONDS=21600 OPENLANE_CONFIG=pd/openlane/config.sky130.json make openlane
make pd-signoff-check
```

`make pd-signoff-check` must only pass against real OpenLane/OpenROAD run output under `pd/openlane/runs/*` or `runs/*`; do not add placeholder GDS/DEF/report files.

`scripts/run_openlane.sh` creates a repo-local lock at `.openlane-run.lock`,
labels Docker containers with `eliza.openlane=1` and the absolute repo
path, and writes a Docker CID file for cleanup. If a run times out or is
interrupted, the launcher removes its own container before clearing the lock.
`scripts/check_openlane_run_preflight.py` reports stale locks or active labeled
containers so duplicate runs are visible before another long PD job starts.

## FPGA scaffold

The owned FPGA target is documented in `docs/board/fpga/README.md` with contract data in `board/fpga/e1_demo_fpga.yaml`.

Run:

```sh
make fpga-check
```

This validates the FPGA scaffold against the RTL/package interface. It does not build a bitstream; that remains blocked until exact board pins are assigned in the LPF constraints.

## PD gates

Run:

```sh
make pd-contract-check
make ci-pd
```

`pd-contract-check` validates package, padframe, and signoff manifest consistency. `ci-pd` runs OpenLane and then requires signoff artifacts through `scripts/check_pd_signoff.py`.
