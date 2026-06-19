# FireSim bring-up on AWS F1 (Rocket + Gemmini)

Status: planning, M5+ cloud-burst path
Owner: board/fpga
Platform decision: see `docs/board/fpga/platform-selection.md`

## Purpose

FireSim is the cloud-burst alternative to owning a VCU118. It compiles the
same Chipyard-generated Rocket+Gemmini target to AWS F1 (`f1.2xlarge`,
`f1.4xlarge`, `f1.16xlarge`) or F2 once it is generally available, and runs
it at hardware speed for long benchmark sweeps that would tie up an on-prem
board for days.

This document is the bring-up runbook. It assumes the program has decided to
use FireSim per the platform-selection decision; if VCU118 is the chosen
path, follow `board/fpga/vcu118/README.md` instead.

## AWS prerequisites

1. AWS account with EC2 F1 quota in `us-east-1` or `us-west-2`. F1 quota is
   off by default; request `Running On-Demand F instances >= 16 vCPU` two
   weeks before first build.
2. S3 bucket for AGFI (Amazon FPGA Image) artifacts in the same region.
3. IAM role permitting `ec2:*`, `s3:*` on the bucket, and `fpga:*` for AGFI
   creation.
4. SSH key pair for the FireSim manager instance.

## Toolchain layout

| Tier              | Instance       | Purpose                              |
|-------------------|----------------|--------------------------------------|
| Manager           | `c5.4xlarge`   | Chipyard build, Vivado, AGFI submit. |
| Build farm        | `z1d.2xlarge`+ | Vivado synthesis (offload, optional).|
| Run farm          | `f1.2xlarge`   | Bitstream execution, one Rocket+Gem. |
| Run farm (large)  | `f1.16xlarge`  | 8 simulators in parallel.            |

Vivado is required on the build instance even in the cloud path; FireSim
wraps it but does not replace it.

## Build phases

### 1. Local metasim (Verilator)

Before any cloud spend, run the same target in metasim on the manager (or a
developer laptop) to confirm functional correctness:

```
cd $CHIPYARD/sims/firesim
./scripts/build-setup.sh
source sourceme-f1-manager.sh
firesim setupexample
firesim runworkload --runworkload-overrides metasim
```

Expected: Linux boots in metasim in roughly 10-30 minutes wall-clock per
simulated boot, depending on host core count.

### 2. F1 AGFI build

```
firesim buildbitstream --hwdb-entry rocket_gemmini_f1
```

Wall-clock budget: 6-10 hours for a first-time XCVU9P build (Vivado synth +
implementation + AFI ingestion by AWS). Subsequent rebuilds with the same
shell are 4-6 hours.

### 3. On-cloud run

```
firesim launchrunfarm
firesim infrasetup
firesim runworkload --hwdb-entry rocket_gemmini_f1 \
                    --workload-name linux-uniform
```

Expected wall-clock for Linux boot to userland shell on F1: **30-90 seconds**
at the simulated SoC clock of ~80-100 MHz. This is the headline win versus
metasim and the reason F1 is worth the cost.

## Cost guard-rails

- `f1.2xlarge` on-demand: ~$1.65/h. Always set a max-runtime guard on the
  workload runner.
- Forgetting to `firesim terminaterunfarm` is the most common cost surprise.
  Add a CloudWatch alarm on EC2 hours-per-day for the FireSim tag.
- AGFI builds incur build-instance hours plus a one-time AFI ingestion fee
  (a few dollars per image).

## What FireSim does not do

- It does not eliminate Vivado. The AGFI build runs Vivado under the hood.
- It does not validate physical timing for ASIC PD; only the FPGA shell.
- It does not provide JTAG to a real RISC-V debug module on F1 (use the
  FireSim TSI/dmi bridge instead).
- It does not replace VCU118 if reproducible per-cycle wall-clock matters --
  AWS instance variance is real.

## References

- `docs/board/fpga/platform-selection.md`
- `board/fpga/vcu118/README.md`
- `docs/generators/chipyard/README.md`
- FireSim docs: https://docs.fires.im
