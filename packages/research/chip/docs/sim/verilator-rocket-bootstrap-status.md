# Chipyard Rocket Verilator Bootstrap Status

Branch: created as `ws/chipyard-rocket-verilator` from `origin/develop`
(committed here on the agent worktree; rebase onto develop before merging)
Host: macOS arm64 (Darwin 25.2.0)
Date: 2026-05-18

## Pinned Chipyard revision

The Chipyard SHA is sourced from
`docs/generators/chipyard/eliza-rocket-manifest.json`:

- repo: `https://github.com/ucb-bar/chipyard.git`
- tag: `main-2026-05-20`
- commit: `48f904aefbb3903dce6efa7901982642853ae6a7`
- previous pin (audited 2026-05-20): `1.13.0` / `69eba860a352343e4ac6b6df0f3638a79a86ec78`

Historical note: the task brief originally referenced SHA
`404c8d361de98a98967f5d7a9bf51cbe8434d4c9`, but `scripts/bootstrap_chipyard.sh`
reads the manifest and pins the manifest-supplied SHA, enforcing a tag/SHA
equality check that aborts on any mismatch. The manifest SHA is the truthful
pin for the ElizaRocketConfig overlay in this repo; no override was attempted.

## What succeeded

1. `scripts/bootstrap_chipyard.sh` ran to completion (exit 0) and produced
   `build/reports/chipyard-bootstrap.log`. It:
   - cloned `external/chipyard` (~12 GB on disk after submodule init)
   - detached HEAD at the pinned SHA
   - recursively initialized the required submodules
     (`rocket-chip`, `tools/cde`, `tools/firrtl2`, `tools/install-circt`,
     `tools/rocket-dsp-utils`, `generators/bar-fetchers`,
     `generators/rocc-acc-utils`, `sims/verilator`, `software/firemarshal`)
   - copied the Eliza config overlay
     (`generators/chipyard/src/main/scala/eliza/ElizaRocketConfig.scala`)
   - ran `scripts/check_chipyard_import_preflight.py` with no errors
2. Pre-existing generated artifacts from a prior Linux build are already
   present in the Chipyard working tree (kept by Chipyard's own `make`;
   NOT committed because `external/chipyard/` is gitignored):
   - Generated Verilog tree:
     `external/chipyard/sims/verilator/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig/`
   - Verilator simulator binary:
     `external/chipyard/sims/verilator/simulator-chipyard.harness-ElizaRocketConfig`
     - `file(1)` reports: `ELF 64-bit LSB pie executable, x86-64, ..., for GNU/Linux 3.2.0`
     - 29,461,832 bytes, mode 0755
     - **Not runnable on this macOS arm64 host.** It must either be
       re-built on macOS arm64 (currently blocked, see below) or executed
       on a Linux x86_64 host / container.

## What failed / was blocked

1. `bootstrap_chipyard.sh` refuses to run `build-setup.sh` on non-Linux
   hosts (`CHIPYARD_RUN_SETUP=1` is gated to `uname -s == Linux`). On this
   macOS arm64 host the script intentionally exits 0 after checkout
   only — no conda env, no SBT install, no FIRRTL/CIRCT install.
2. Host tooling state:
   - `java`: present (`/opt/homebrew/opt/openjdk@21/bin/java`)
   - `verilator`: present (`/opt/homebrew/bin/verilator`)
   - `conda`: present (`/opt/miniconda3/bin/conda`)
   - `sbt`: **missing** — Chipyard installs it inside its conda env via
     `build-setup.sh`, which is gated off here.
3. Even with the host tools installed manually, Chipyard `main-2026-05-20`
   has not been validated upstream on macOS arm64. Known friction points:
   - `tools/install-circt` ships Linux x86_64 binaries; needs a darwin
     arm64 CIRCT (build from source or use a Homebrew tap) before any
     FIRRTL -> Verilog step will work.
   - `riscv-tools` is normally installed via the same conda flow; on
     darwin arm64 this requires replacing the conda-distributed binaries
     with `brew install riscv-gnu-toolchain` or an equivalent.
   - `sims/verilator/Makefile` assumes GNU make semantics and a verilator
     linked with glibc-style flags; macOS verilator from Homebrew works,
     but the prebuilt simulator binary cannot be reused.
4. `make CONFIG=RocketConfig` (or `ElizaRocketConfig`) was **not**
   attempted in this session because (a) without `env.sh` populated by
   `build-setup.sh` the SBT classpath is undefined, and (b) the time-box
   would not cover the 30+ minute Scala/Verilator build even on a primed
   environment.

## Exact next commands

### Quickest path: Linux x86_64 host (recommended)

```sh
# On a Linux x86_64 host with >= 80 GB free disk, >= 32 GB RAM:
git clone <this-repo> eliza-e1-chip
cd eliza-e1-chip
git checkout ws/chipyard-rocket-verilator

# 1. Clone Chipyard at pinned SHA and install full env (conda + SBT +
#    riscv-tools + CIRCT). Expect 30-60 min on first invocation.
CHIPYARD_RUN_SETUP=1 bash scripts/bootstrap_chipyard.sh

# 2. Generate Verilog and build the Verilator simulator for
#    ElizaRocketConfig. Expect 60-180 min on first run (Scala
#    compile + FIRRTL elaboration + Verilator C++ compile).
CHIPYARD_RUN_SETUP=1 CHIPYARD_GENERATE_VERILOG=1 \
  bash scripts/bootstrap_chipyard.sh

# 3. Resulting simulator binary:
ls external/chipyard/sims/verilator/simulator-chipyard.harness-ElizaRocketConfig

# 4. Smoke test with a RISC-V ELF (e.g. an OpenSBI/BBL payload):
external/chipyard/sims/verilator/simulator-chipyard.harness-ElizaRocketConfig \
  +verbose path/to/kernel.elf 2>&1 | tee build/reports/sim-smoke.log
```

### Fallback inside Chipyard's official container

```sh
docker pull ucbbar/chipyard-image:latest
docker run --rm -it -v "$PWD":/work -w /work ucbbar/chipyard-image:latest bash
# Then run the same three steps above inside the container.
```

### macOS arm64 (not recommended for first bringup)

`bootstrap_chipyard.sh` will not run `build-setup.sh` for you on darwin.
A manual path is roughly:

```sh
brew install sbt verilator dtc bash gawk gnu-sed coreutils
# Install a darwin arm64 RISC-V toolchain (build from source or via tap).
# Install/build a darwin arm64 CIRCT (firtool).
cd external/chipyard
# Hand-author env.sh entries for SBT, CIRCT, RISC-V toolchain.
source env.sh
cd sims/verilator
make CONFIG=ElizaRocketConfig PACKAGE=eliza -j$(sysctl -n hw.ncpu)
```

Expect to debug Makefile assumptions and CIRCT/firtool packaging for
several hours minimum. Upstream Chipyard does not test darwin arm64.

## Wall-clock estimates for a fresh Linux x86_64 run

| Phase | Estimate |
| --- | --- |
| `bootstrap_chipyard.sh` clone + submodules | 5 - 15 min (network bound) |
| `build-setup.sh` (conda + SBT + riscv-tools + CIRCT install) | 30 - 60 min |
| First Scala/SBT compile + FIRRTL elaboration | 20 - 45 min |
| Verilator C++ compile of generated Verilog | 30 - 90 min |
| Incremental rebuilds after one-line Scala edits | 3 - 10 min |
| Total for a clean machine to first simulator run | 2 - 4 h |

## Files added / changed by this session

- `docs/sim/verilator-rocket-bootstrap-status.md`: this file.
- `build/reports/chipyard-bootstrap.log`: full bootstrap stdout/stderr.
- `external/chipyard/` is already covered by the repo `.gitignore`
  (no edits required to keep the 12 GB checkout out of git).
