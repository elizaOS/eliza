# TSMC A14 stub — stretch 2028 production target (BLOCKED)

Fail-closed evidence file for TSMC A14 (baseline, frontside-PDN). A14 is the
stretch 2028 production target: +15% perf @ iso-power or -30% power @ iso-perf
vs N2 with +20% logic density.

The A14P (SPR-BSPDN) variant slips to 2029 and is **not** the 2028 path. For a
2028 phone product, frontside PDN is the safe call.

This directory contains no A14 PDK data, library, GDS, LEF, extraction view,
SRAM macro, PHY hard-IP, or signoff report. See `access-gate.yaml` for the
procurement preconditions.

Related:
- `pd/corner-manifests/tsmc-a14.yaml`
- `pd/library-manifests/tsmc-a14.yaml`
- `docs/pd/process-node-selection.md`
- `docs/evidence/process/pdk-access-gate.yaml`
