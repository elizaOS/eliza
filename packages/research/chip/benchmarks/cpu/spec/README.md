## SPEC CPU 2017 — license-restricted

This directory **does not** and **must not** include SPEC CPU 2017 sources
or binaries. SPEC CPU 2017 is licensed by the Standard Performance
Evaluation Corporation under a per-organization paid license and a
non-redistribution clause.

### What lives here

| File | Purpose |
|---|---|
| `manifest.json` | Pinned SPEC version, suite scope, expected run commands. |
| `../../../scripts/run_spec.sh` | Fail-closed harness for either a licensed local `$SPEC_DIR` run or archived target runcpu transcript intake. |

### Compliance

The harness has two legal modes:

1. Archived target transcript intake: `E1_SPEC_RAW_OUTPUT`,
   `E1_SPEC_TARGET_METADATA`, `E1_SPEC_TARGET_RUNNER`,
   `E1_SPEC_RUN_MANIFEST`, and
   `SPEC_LICENSE_SHA256`/`E1_SPEC_LICENSE_SHA256` must be set. The runner must
   be `prototype`, `silicon`, or `phone`; the transcript, metadata, and run
   manifest are hashed; and only numeric scores plus provenance enter the
   result JSON. The run manifest must bind SPEC CPU2017 version, runcpu
   command, config, reportable status, and the result-bundle hash.
2. Licensed local execution: refuses to run unless `SPEC_DIR` points at a
   directory that
   contains `bin/runcpu` and a `version.txt` matching the pinned version.
3. Refuses to run unless `SPEC_LICENSE_SHA256` matches the SHA-256 of
   the operator's license file, recorded out-of-band in the operator's
   procurement system (NOT in this repo).
4. Refuses to redistribute any SPEC artifact. Result JSON only records
   numeric scores, configuration metadata (compiler, flags, runtime), and
   the run timestamp. Raw SPEC binaries, sources, and license keys never
   enter the repo.

### Expected targets (from the OoO domain report)

| Benchmark | Metric | 2028 e1-ultra target | Reference |
|---|---|---|---|
| SPEC CPU2017 int rate | per-core | ≥ 9 | X925 ~11.8, A19 ~12 |
| SPEC CPU2017 int speed | speed | ≥ 7 | X925 ~8, Zen 5 ~9 |
| SPEC CPU2017 fp rate | rate | ≥ 7 | X925 ~10, Zen 5 ~14 |

These remain BLOCKED until silicon evidence exists. Any pre-silicon
projection is a gem5 / Verilator extrapolation and must be labeled
"modeled" in the result file.

### How to get a license

Contact SPEC: https://www.spec.org/spec/contact.html

### Reproducibility expectations

When the harness can run end-to-end:

- Compiler: pinned LLVM with RVV 1.0 vectorization enabled.
- `runcpu --config eliza-rva23u64.cfg --action validate`.
- `runcpu --action runspeed` and `--action runrate`.
- Three iterations, median reported, full set of `intspeed`, `intrate`,
  `fpspeed`, `fprate` subscores.
