# Tapeout-readiness aggregator

`scripts/aggregate_tapeout_readiness.py` walks every fail-closed gate the chip
package owns and emits a single JSON report at
`build/reports/tapeout-readiness.json`. The aggregator is **view-only**: it does
not modify any individual gate, does not regenerate any evidence file, and
does not promote any silicon, boot, MLPerf, or release claim. It exists so a
reviewer can see one consolidated snapshot of where the package stands without
running `make smoke` and reading 30 separate log streams.

## How to run

```bash
make tapeout-readiness          # informational; exit 1 only if any gate FAILs
make tapeout-readiness-strict   # strict; exit 1 if any gate is FAIL *or* BLOCKED
make tapeout-readiness-test     # unit tests for the aggregator itself
```

Both make targets shell out to `scripts/aggregate_tapeout_readiness.py`. The
non-strict target prints a human summary table and exits 0 when no gate is
`FAIL`. The strict target additionally treats `BLOCKED` as a release blocker
and is what release claims must consult.

## Output schema

The report obeys the `eliza.tapeout_readiness.v1` schema:

```json
{
  "schema": "eliza.tapeout_readiness.v1",
  "as_of": "<ISO date>",
  "gates": [
    {
      "name": "cpu-2028-target-check",
      "status": "PASS",
      "evidence": "cpu 2028 target check passed",
      "subsystem": "cpu",
      "tier": "spec"
    }
  ],
  "summary": { "pass": 30, "fail": 5, "blocked": 11 },
  "release_blocker": true,
  "claim_boundary": "tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim"
}
```

- `subsystem` is one of `cpu`, `memory`, `security`, `npu`, `process`, `pd`,
  `platform`, `bsp`, `verify`, `benchmarks`.
- `tier` is one of `spec`, `rtl`, `pd`, `silicon`. The tier records the
  abstraction layer the gate guards, not the maturity of the gate itself.
- `evidence` is the most informative single line (up to 200 chars) lifted from
  the gate's combined stdout/stderr — preferring `STATUS:`, `FAIL:`, or
  `BLOCKED` lines, falling back to the first non-empty line.

## Classification policy (exact prefix-based rule)

For each gate the aggregator runs the underlying `scripts/check_*.py` (or
`verify/check_stub_audit.py`) script, captures its return code and combined
output, and classifies the result as follows:

| Signal                                       | Classification |
| -------------------------------------------- | -------------- |
| `STATUS: BLOCKED` substring anywhere         | `BLOCKED`      |
| non-zero exit code (no `STATUS: BLOCKED`)    | `FAIL`         |
| zero exit code (no `STATUS: BLOCKED`)        | `PASS`         |

`BLOCKED` is **not** a release blocker on its own — it is the package's
existing fail-closed marker for external dependencies (foundry PDK access,
AOSP Cuttlefish RV64 transcripts, MLPerf Mobile/Power evidence, OpenLane
Docker image, live SymbiYosys engines, RV cross toolchain, etc.). Only `FAIL`
flips `release_blocker` to `true` in the non-strict report.

The strict report (`make tapeout-readiness-strict`) treats both `FAIL` and
`BLOCKED` as release blockers and is the gate that release claims must use.

## Release-claim policy

A release claim ("E1 is tape-out-ready") requires **all** of:

1. `make tapeout-readiness-strict` exits 0 — every gate listed in
   `scripts/aggregate_tapeout_readiness.py` is `PASS`.
2. Every row in the
   [`research/00_integration_shortlist.md`](../../research/00_integration_shortlist.md)
   "What stays BLOCKED (external dependencies, by design)" list is resolved:
   - Cuttlefish RV64 / AOSP boot transcript captured.
   - OpenSBI + U-Boot + Linux qemu-virt smoke captured.
   - OpenLane silicon-class signoff completes.
   - AOSP HAL evidence transcripts replace `status=FAIL` placeholders.
   - MLPerf Mobile / MLPerf Power closed loop captured (requires fabricated
     silicon).
   - Foundry PDK selection committed (`selected_process_option` no longer
     `blocked_until_foundry_pdk_and_library_selection_from_shortlist`).
3. The existing release-evidence make targets (`make ci-release-evidence`,
   `make pipeline-check-strict`, `make pd-signoff-check`) also pass.

Until both (1), (2), and (3) are satisfied, the chip package's
`claim_boundary` field stays at
`tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim` and no
release claim is published.

## Current snapshot (2026-05-19)

From a local run of `make tapeout-readiness` on `develop`:

```text
summary: PASS=38 FAIL=3 BLOCKED=6  release_blocker=True  strict=False
```

`release_blocker=True` because three gates fail: `padframe-check`,
`package-cross-probe-check`, and `aosp-simulator-completion-check` (the last
exits non-zero and prints `AOSP simulator completion gate BLOCKED:` — the
strict prefix policy requires `STATUS: BLOCKED` to classify as `BLOCKED`).

The six `BLOCKED` rows are:

- `cpu/core-selection-check` (Ascalon-D8 big-core license/procurement gap)
- `cpu/cpu-ap-completion-gate` (no real RV64GC Linux AP completion claim)
- `cpu/rva23-compliance` (`rva23.aosp_branch_pin` pending)
- `pd/pd-util-check` (no utilization key in latest OpenLane run)
- `bsp/minimum-linux-target-check` (no Linux kernel boot transcript)
- `bsp/minimum-linux-npu-target-check` (no Linux NPU smoke transcript)

The breakdown — every line in `build/reports/tapeout-readiness.json` —
reflects the existing fail-closed state already documented in
`research/00_integration_shortlist.md`:

- `FAIL` gates record real preflight problems (missing PD signoff manifest,
  padframe pin gaps, AOSP simulator completion gate, antenna metadata
  blockers, scaffolded BSP evidence still in placeholder state). These are
  pre-existing fail-closed conditions; the aggregator surfaces them, it does
  not introduce them. Each `FAIL` row points to the canonical gate that owns
  the artifact.
- `BLOCKED` gates record the external dependencies enumerated in
  `research/00_integration_shortlist.md` (PDK access, OpenLane utilisation
  report, Linux/Android boot transcripts, MLPerf evidence). These remain the
  same documented external blockers, not new ones.

The current PASS/FAIL/BLOCKED counts will move as the BSP and PD evidence
streams land. Re-run `make tapeout-readiness` after any gate change; the
report file is regenerated atomically and is the canonical artifact.

## Gate inventory

The curated list of gates lives in the `GATES` tuple at the top of
`scripts/aggregate_tapeout_readiness.py`. Each entry binds a Makefile target
name to a `scripts/check_*.py` script, a `subsystem`, and a `tier`. To add a
new gate:

1. Author the underlying `scripts/check_*.py` and its Makefile target first.
2. Append a `GateSpec(...)` row to `GATES`.
3. Run `make tapeout-readiness-test` to confirm the new gate's script path
   exists and the inventory test still passes.

Long-running cocotb, formal, Verilator, OpenLane, and QEMU targets are
intentionally **not** in the aggregator. They are owned by `make ci-fast`,
`make ci-pd`, and `make ci-release-evidence` and run in their own lanes.
