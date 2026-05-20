# Physical, Power, Thermal, Package, PCB, Manufacturing Optimization Work Order

## OpenLane/OpenROAD

OpenLane/OpenROAD runs are useful only when the exact run directory, tool image,
PDK, corners, constraints, and reports are archived. Preflight success is not
PD closure.

## IR-drop and PDN

IR-drop, EM, PDN impedance, rail current, and decoupling evidence must be tied
to selected workloads, voltage corners, package assumptions, board stackup, and
regulator limits.

Static IR-drop, PDN topology, and tool reproducibility are now contract-bound
in `pd/signoff/run-manifest.schema.json`: every release run must declare a
`psm_ir_drop_report` artifact path, a fully populated `pdn_topology` block
matching the strap/ring parameters in `pd/openlane/config.sky130.json`, and
per-tool digests (`volare_pdk_digest`, `klayout_digest`, `magic_digest`,
`netgen_digest`, `openroad_digest`, `yosys_digest`, `abc_digest`,
`antenna_deck_digest`) computed via `scripts/record_tool_digests.sh`. The
schema lets a tool that is genuinely not installed locally be recorded as
`unavailable` with a sibling `<tool>_unavailable_reason`, but `unavailable`
on its own is fail-closed in `scripts/check_pd_signoff.py`.

## thermal

Thermal closure requires post-route power, package and board model, enclosure
assumptions, battery/PMIC losses, measurement points, stop conditions, chamber
data, and skin-temperature limits.

The current modeled no-throttle work order is
`docs/architecture-optimization/soc-optimized-operating-point.yaml`. It targets
`<= 95 C` modeled die temperature across the required 14A process corners, but
it remains planning evidence only until correlated activity, package, board,
enclosure, chamber, and PDK signoff artifacts replace the model.

## DFT

DFT, boundary scan, manufacturing test, serialization, calibration, and debug
lock state must have station transcripts before fabrication or production
claims.
