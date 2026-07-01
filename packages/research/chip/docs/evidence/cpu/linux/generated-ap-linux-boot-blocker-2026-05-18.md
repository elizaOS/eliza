# Generated AP Linux Boot Blocker - 2026-05-18

Status: blocked, fail-closed.

Scope: generated Chipyard `ElizaRocketConfig` AP Linux boot evidence for
`scripts/check_minimum_linux_npu_target.py`.

## What Passed

- Chipyard checkout preflight passes:
  `python3 scripts/check_chipyard_import_preflight.py --require-checkout`
- Verilator preflight passes:
  `python3 scripts/check_chipyard_verilator_preflight.py`
- Payload locator passes and selects:
  `external/chipyard/software/firemarshal/images/firechip/linux-poweroff/linux-poweroff-bin-nodisk`
- Stale `/work` generated metadata was repaired/removed enough for a clean
  Docker smoke attempt to start from the current wrapper.

## Attempted Command

```sh
CHIPYARD_LINUX_SMOKE_USE_DOCKER=1 \
CHIPYARD_LINUX_SMOKE_CLEAN=1 \
CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS=600 \
CHIPYARD_LINUX_SMOKE_JOBS=1 \
scripts/run_chipyard_eliza_linux_smoke.sh
```

The current Docker wrapper seeds both expected boot ROM images into the generated
target directory before Chipyard elaboration:

```text
eliza-evidence: seeded_bootrom=/work/external/chipyard/sims/verilator/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig/bootrom.rv64.img
eliza-evidence: seeded_bootrom=/work/external/chipyard/sims/verilator/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig/bootrom.rv32.img
```

## Current Blocker

The smoke run produced a closed transcript, but it is not boot evidence:

- Transcript: `build/chipyard/eliza_rocket/verilator-linux-smoke.log`
- Report: `build/chipyard/eliza_rocket/verilator-linux-smoke.json`
- Exit code: `137`
- Missing required markers: `OpenSBI`, `Linux version`
- Instruction trace is stale relative to the current smoke log.

During this pass, multiple detached Chipyard Docker runners were active and
writing the same generated tree. They were stopped to avoid corrupting the
generated evidence state. No active
`eliza/chipyard-eliza-minimal-amd64:1.13.0` containers remained after
the stop.

## Exact Next Action

Run one generated-AP smoke job at a time, with no parallel Chipyard Docker jobs:

```sh
docker ps --filter ancestor=eliza/chipyard-eliza-minimal-amd64:1.13.0
CHIPYARD_LINUX_SMOKE_USE_DOCKER=1 \
CHIPYARD_LINUX_SMOKE_CLEAN=1 \
CHIPYARD_LINUX_SMOKE_TIMEOUT_SECONDS=1200 \
CHIPYARD_LINUX_SMOKE_JOBS=1 \
scripts/run_chipyard_eliza_linux_smoke.sh
eval "$(python3 scripts/locate_chipyard_linux_payload.py --export-env)"
CHIPYARD_ALLOW_CONTAINER_GENERATED_PATHS=1 \
python3 scripts/check_chipyard_verilator_linux_smoke.py
```

The gate must remain blocked until the real generated-AP transcript contains
both `OpenSBI` and `Linux version`.
