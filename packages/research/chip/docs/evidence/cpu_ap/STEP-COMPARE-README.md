# e1-pro Spike step-and-compare (tandem) lane

This is E1's adoption of CVA6/OpenHW's continuous instruction-level
conformance methodology — the axis on which E1 previously **lost** to
Ariane (`docs/architecture-optimization/ariane-cva6-gap-analysis.md` §3,
"Verification maturity"). The fix is to *adopt*, not reinvent: e1-pro **is**
CVA6 (`cv64a6_imafdc_sv39`; see `core-selection.json`), so it inherits CVA6's
RVFI infrastructure and Spike step-and-compare directly.

## What it proves

For each test, the same ELF runs on two engines and their **retired-instruction
streams are diffed instruction-by-instruction**:

- **Golden ISS** — CVA6's pinned Spike (`external/cva6/cva6/tools/spike`, built
  with `--log-commits`), the same reference core-v-verif uses.
- **RTL DUT** — the CVA6 RTL under Verilator (`work-ver/Variane_testharness`,
  the `corev_apu` ariane_testharness), which wires the **same `cva6_rvfi`
  decoder** that `rtl/cpu/e1_cva6_wrapper.sv` now exposes (see "RVFI wiring").

Compared fields per retired instruction: **retired PC**, **instruction word**,
**destination register address**, and **destination writeback value**.

Performance-counter reads (`mcycle`/`minstret`/`cycle`/`time`/`instret`) are
intrinsically non-deterministic between a cycle-accurate RTL model and a
functional ISS; core-v-verif's tandem scoreboard excludes them, and so does
this lane (with taint propagation through registers and memory so values
derived from a counter read are also excluded). **Retired PC and instruction
word are never excluded** — control-flow and decode are checked exactly.

## Workload

The vendored **riscv-tests ISA conformance suite** (`p`-mode: physical
addressing, machine mode), spanning RV64 I / M / C / A. These are
self-checking and I/O-free, so they are deterministic on both engines and
terminate via HTIF `tohost`. Programs that emit console output
(dhrystone/CoreMark) are deliberately *not* used as the tandem workload:
their `printf` path diverges on UART/HTIF console behaviour modelled
differently by the functional ISS and the RTL testharness — an environment
artifact, not a core conformance signal.

## RVFI wiring (the gap closure in the wrapper)

`rtl/cpu/e1_cva6_wrapper.sv` previously left `rvfi_probes_o` unconnected. It
now (under `+define+E1_RVFI`):

1. builds the RVFI probe/instruction/csr types from CVA6's own
   `core/include/rvfi_types.svh` macros,
2. connects `rvfi_probes_o` to the probe bus,
3. instantiates `cva6_rvfi` to decode the probe bus into the architectural
   retired-instruction stream (exactly as `ariane_testharness.sv` does), and
4. flattens that stream onto a wrapper output surface
   (`rvfi_valid_o`/`rvfi_pc_rdata_o`/`rvfi_insn_o`/`rvfi_rd_addr_o`/
   `rvfi_rd_wdata_o`/...), also driving `dbg_pc_o`/`dbg_valid_o` from commit
   port 0.

`+define+E1_RVFI` is off by default, so the existing `cocotb-cva6-cpu` flow is
unchanged; both the default and RVFI configurations elaborate clean under
Verilator (`--lint-only`, 0 errors).

## Run it

```sh
scripts/run_e1_step_compare.sh
# or
make cpu-step-compare
```

Knobs: `E1_STEP_COMPARE_MAX_INSNS` (per-test compare cap),
`E1_STEP_COMPARE_SPIKE_STEPS` (Spike step bound).

## Fail-closed contract

The lane writes `e1-step-compare.json` (schema `eliza.cpu_step_compare.v1`,
`claim_level: L1_RTL_FULL_SOC`, `provenance: simulator`). It is `blocked`
(naming the missing dependency and the next command) if the CVA6 checkout,
pinned Spike, the Verilator model, or the riscv-tests sources are absent;
`failed` (exit 1) if any retired-instruction mismatch is found; `passed` only
when every test compared with **0 mismatches**. Counter nondeterminism is
never silently turned into a pass — it is an explicit, documented exclusion of
the affected `rd_wdata` checks only.

## Claim level and what remains

- **Claim level `L1_RTL_FULL_SOC` (simulator)** — this is RTL-vs-ISS evidence,
  not silicon. See `docs/benchmarks/claim-ladder.md`.
- The lane runs against the **upstream CVA6 RTL** (`Variane_testharness`),
  which is e1-pro by selection. The `e1_cva6_wrapper.sv` RVFI surface is wired
  and elaborates, but the wrapper's own cocotb harness does not yet run a full
  HTIF program in tandem; running this exact step-compare through the wrapper
  (rather than the upstream testharness) is the remaining integration step.
- Constrained-random (riscv-dv) stimulus and functional-coverage closure
  remain follow-on items for full core-v-verif parity.
