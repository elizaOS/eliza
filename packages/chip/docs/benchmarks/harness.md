# Benchmark Harness

The first benchmark harness lives under `benchmarks/` and is a command planner
plus thin runner for the first v0 benchmark set:

- CoreMark
- STREAM
- lmbench `bw_mem`
- lmbench `lat_mem_rd`
- fio sequential and random profiles
- TensorFlow Lite `benchmark_model` on CPU and the future e1 NPU path

It is intentionally safe on a workstation without those tools installed. Planning
mode reports every command and marks unavailable binaries or blocked model
artifacts without executing anything.

## CLI Commands

Run these commands from `packages/chip`:

List configured benchmarks and installation hints:

```sh
python3 benchmarks/run_benchmarks.py list
```

Create a dry-run report:

```sh
python3 benchmarks/run_benchmarks.py plan --report-id dry-run
```

Execute available benchmarks:

```sh
python3 benchmarks/run_benchmarks.py run \
  --report-id board-smoke-001 \
  --platform eliza-e1 \
  --platform-revision dev-board-a \
  --claim-level L4_DEV_BOARD
```

Validate an existing report:

```sh
python3 benchmarks/run_benchmarks.py validate-report benchmarks/results/dry-run/report.json
```

## Phone L5/L6 Claim Gate

The phone CPU claim gate is fail-closed until real target transcripts and
metadata are archived:

```sh
make cpu-phone-l5-l6-benchmark-report
make cpu-phone-benchmark-claim-gate-strict
python3 scripts/check_cpu_phone_benchmark_claim_gate.py --no-write --strict
```

Check whether the TFLite CPU benchmark is ready to run with a real
`benchmark_model` binary and the local smoke model:

```sh
python3 scripts/check_tflite_cpu_benchmark.py \
  --status-json benchmarks/results/tflite-cpu-readiness/status.json
```

Check both TFLite entries, including the e1-npu NNAPI proof gate:

```sh
python3 scripts/check_tflite_cpu_benchmark.py \
  --benchmark all \
  --status-json benchmarks/results/tflite-readiness/status.json
```

## Dry Run

```sh
python3 benchmarks/run_benchmarks.py plan --report-id dry-run
```

The command writes:

```text
benchmarks/results/dry-run/report.json
benchmarks/results/dry-run/<benchmark>.log
```

Use `--bench <name>` to select a single benchmark. Valid names are defined in
`benchmarks/configs/benchmark_plan.json`. For compatibility, the old option-only
form still works:

```sh
python3 benchmarks/run_benchmarks.py --dry-run --report-id dry-run
```

## Real Run

Install the benchmark tools on the target host or board, then run:

```sh
python3 benchmarks/run_benchmarks.py run \
  --report-id board-smoke-001 \
  --platform eliza-e1 \
  --platform-revision dev-board-a \
  --claim-level L4_DEV_BOARD
```

For local host smoke evidence, use the repo `.venv` and the checked-in smoke
commands:

```sh
make venv
scripts/install_benchmark_smoke_tools.sh
.venv/bin/python benchmarks/models/generate_mobile_smoke_tflite.py \
  --out benchmarks/models/mobile_smoke.tflite
PATH="$PWD/.venv/bin:$PWD/benchmarks/tools:$PATH" make benchmarks-local-host-evidence
```

For strict CoreMark and STREAM runs, install real upstream builds ahead of the
smoke shims. The runner searches `tools/bin` first, then `.venv/bin`, then the
ambient `PATH`; in strict mode it skips repo-local smoke shims and continues
searching for a real executable. A source-based helper is available:

```sh
scripts/install_coremark_stream_tools.sh \
  --coremark-src /path/to/eembc-coremark \
  --stream-src /path/to/stream
```

The helper installs `tools/bin/coremark` and `tools/bin/stream_c.exe`. It only
builds from explicit or already-vendored source checkouts and does not download
or synthesize benchmark binaries. If sources are missing, it exits with code `2`
and prints the blocker. Verify the installed tools are not smoke shims with:

```sh
scripts/install_coremark_stream_tools.sh --check
```

Missing tools are recorded as `missing_dependencies` and do not abort the whole
run unless `--strict-missing` is passed. Missing or placeholder model artifacts
are recorded as `blocked_assets` with status `blocked`; they also make
`--strict-missing` return non-zero. Failed commands, timeouts, and runner errors
return a non-zero exit status.

Strict mode rejects the repo-local smoke shims in `benchmarks/tools`, including
symlinks installed into `.venv/bin`. If a real executable with the same command
name exists later on `PATH`, the runner records and executes that resolved path
instead of letting the smoke shim shadow it.

`--allow-host-smoke-tools` is accepted only with `--claim-level L2_ARCH_SIM`.
Board, prototype, or product release claims must use real benchmark executables.

Expected status codes:

- `0`: report generated and no executed benchmark failed.
- `1`: at least one executed benchmark failed, timed out, or hit a runner error.
- `2`: `--strict-missing` found missing dependencies or blocked assets.
- `3`: generated or supplied report failed schema validation.

## Configuration

`benchmarks/configs/benchmark_plan.json` is the source of truth for the skeleton
commands. Keep command arrays shell-free and explicit. The runner checks:

- `requires`: executables expected on `PATH`
- `required_files`: repository-relative files, such as a TFLite model
- `timeout_seconds`: per-benchmark timeout override

The TFLite entries reference `benchmarks/models/mobile_smoke.tflite` as a tiny
smoke model artifact. The optional generator is offline-only:

```sh
python3 benchmarks/models/generate_mobile_smoke_tflite.py \
  --out benchmarks/models/mobile_smoke.tflite
```

It uses an already-installed TensorFlow package and does not download anything.
If TensorFlow is not installed, it exits with code `2` and prints/writes a
machine-readable blocker. Until a real non-proprietary model exists, plan and
run commands report those entries as `blocked` rather than passing them as real
performance. A tiny placeholder file is also blocked by the configured
`min_size_bytes` check.

The STREAM entry uses `stream_c.exe` by default to avoid confusing ImageMagick's
unrelated `stream` utility with the memory benchmark.

## Installing Or Supplying Benchmarks

For local dependency smoke testing, use the repository venv path:

```sh
make venv
.venv/bin/python -m pip install tensorflow
make benchmark-tools
PATH="$PWD/.venv/bin:$PATH" make benchmarks-local-host-evidence
```

The venv tools under `benchmarks/tools/` are host smoke wrappers. They prove the
harness can execute and parse each benchmark family on this workstation; they
are not target-board, prototype-silicon, or complete-phone performance evidence.
The release runner intentionally blocks `benchmarks/metadata/local-host-smoke.json`;
use target metadata with UTC calibration timestamps and SHA-256 calibration
asset digests before invoking `benchmarks/run_benchmarks.py --strict-missing`
for a claimable benchmark report.
`tflite_e1_npu` must still fail until a real `e1-npu` NNAPI path exists,
and `simulator_arch_metrics` must still reject QEMU liveness-only data as
calibrated benchmark evidence. For local CPU/AP modeling, run
`make benchmark-cpu-ap-sim-metrics`; that writes deterministic 14A
architecture metrics, including modeled process-corner, power, and thermal
fields, but still does not create PDK, RTL, silicon, AOSP, or phone-score
evidence.

| Benchmark | What the harness expects | How to provide it |
|---|---|---|
| CoreMark | `coremark` on `PATH` | Build EEMBC CoreMark for the target compiler and install or copy the executable into the benchmark user's `PATH`. `scripts/install_coremark_stream_tools.sh --coremark-src <dir> --only coremark` installs to `tools/bin/coremark`. |
| STREAM | `stream_c.exe` on `PATH` | Compile STREAM from source for the target, keep the binary name `stream_c.exe`, and put it on `PATH`. `scripts/install_coremark_stream_tools.sh --stream-src <dir> --only stream` installs to `tools/bin/stream_c.exe`; the name avoids colliding with ImageMagick's `stream`. |
| lmbench bandwidth | `bw_mem` on `PATH` | Build lmbench for the target and expose `bw_mem` on `PATH`. If a repo `.venv/bin/bw_mem` smoke symlink exists, strict mode skips it and keeps searching for a real executable later on `PATH`. |
| lmbench latency | `lat_mem_rd` on `PATH` | Build lmbench for the target and expose `lat_mem_rd` on `PATH`. If a repo `.venv/bin/lat_mem_rd` smoke symlink exists, strict mode skips it and keeps searching for a real executable later on `PATH`. |
| fio sequential read | `fio` on `PATH` | Install fio from the target OS package manager or cross-build it. The job file is `benchmarks/configs/fio-seq-read.fio`. |
| fio random read/write | `fio` on `PATH` | Install fio from the target OS package manager or cross-build it. The job file is `benchmarks/configs/fio-rand-rw.fio`. |
| TFLite CPU | `benchmark_model` on `PATH` and `benchmarks/models/mobile_smoke.tflite` | Build TensorFlow Lite's benchmark tool and generate or supply a redistributable smoke model. Do not use proprietary app or vendor models unless the report is kept private and marked accordingly outside this harness. |
| TFLite e1 NPU | NNAPI-capable `benchmark_model`, `benchmarks/models/mobile_smoke.tflite`, and `benchmarks/capabilities/e1_npu_nnapi.proof.json` | Build `benchmark_model` with NNAPI support, generate or supply the smoke model, and run on a platform exposing the `e1-npu` accelerator name. The proof JSON must reference non-empty transcripts with the expected `e1-npu` and NNAPI command markers. Use `docs/benchmarks/capabilities/e1_npu_nnapi.proof.template.json` as the job output shape, not as evidence. |

The checked-in `benchmarks/tools/*` commands are host smoke tools for CI and
developer machines. They intentionally preserve the command names and output
shape expected by the harness, but reports using them are not target CoreMark,
STREAM, lmbench, or TFLite NNAPI product evidence. Product or board claims must
replace them with target-built upstream binaries and include clock, thermal,
power, compiler, and platform metadata.

Do not copy or symlink any `benchmarks/tools/*` smoke command into `tools/bin`
for a strict run. The runner detects the `eliza-host-smoke` provenance
marker and treats those shims as missing dependencies unless
`--allow-host-smoke-tools` is explicitly used.

For local CLI wiring of a built lmbench tree, point the helper at the directory
that contains real `bw_mem` and `lat_mem_rd` executables:

```sh
scripts/install_benchmark_smoke_tools.sh \
  --lmbench-bin-dir /path/to/lmbench/bin/<target>
```

The helper still installs the other host smoke tools, but links lmbench to the
supplied real binaries and refuses inputs containing the repo host-smoke marker.
Generated reports include executable SHA-256, size, provenance, and any rejected
host-smoke candidates in each executable dependency record.

`scripts/check_bandwidth_sustained.py` is a parser and threshold checker, not a
release-evidence promoter. A parser-only output can set
`target_thresholds_status: pass`, but `release_claim_allowed` remains `false`
and `pass_fail_against_phone_2028_target_profile.overall` remains `downgraded`
until real target identity, raw artifacts, process-contract hashes, and
contention/QoS traces satisfy the real-report validator
(`scripts/check_memory_evidence_templates.py --report`). Real memory reports
must archive every `raw_artifacts[].path` under `packages/chip` with file
contents matching `raw_artifacts[].sha256`; when `contended_trace_present` is
`pass`, `contention_workload.raw_trace_path` must be one of those hash-bound raw
artifacts.

For e1-npu NNAPI evidence, the harness validates the proof JSON schema,
accelerator name, transcript presence, and required transcript markers before
the benchmark can move out of `blocked`. A strict release report that only has
repo-local smoke tools, an empty proof, or copied template content must stay
blocked or fail report validation.

## Report Shape

The generated report is JSON and maps onto the project benchmark schema in
`docs/benchmarks/report-schema.yaml`. The runner validates generated reports
before writing them and can validate an existing report with `validate-report`.
The runner parses primary metrics for CoreMark-shaped, STREAM-shaped, lmbench,
fio JSON, and TFLite `benchmark_model` output and still archives raw logs for
auditability.

Blocked model assets include stable `blocker_id`, `pipeline_visible`, and
`release_blocking` fields. Release and CI jobs should fail on any blocked asset
where both booleans are true.

For any real `passed` benchmark result, calibration metadata must identify a
UTC calibration instant and immutable evidence digests. The runner rejects
local timestamps such as `2026-05-19 12:00:00`, non-UTC offsets, and placeholder
hashes such as `host-smoke`; use ISO-8601 UTC (`Z` or `+00:00`) for
`calibration.last_calibrated_utc` and 64-character lowercase SHA-256 hex for
each required calibration asset `sha256`. For phone L5/L6 claim gates,
`calibration.assets.<name>.evidence` must be an archived artifact path under
`packages/chip`, and the file hash must match the asset `sha256`. Imported
L5/L6 target metadata must also bind `process.process_effects_contract.path` to
`docs/spec-db/process-14a-effects.yaml`; when checked with `--artifact-root`, the
metadata `process.process_effects_contract.sha256` must match that archived
contract file. CPU side-result runners add benchmark-specific required assets:
CoreMark requires `coremark_binary`, Dhrystone requires `dhrystone_binary`, and
JetStream requires `jetstream_engine`, in addition to `clock_source` and
`power_meter`.
