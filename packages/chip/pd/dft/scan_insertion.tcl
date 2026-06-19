# Open-flow scan-prep (standard FF mapping) for e1_chip_top.
#
# Background: Yosys upstream does NOT ship a `scanchain` pass that
# transparently converts D-FFs into scan equivalents, and `dfflibmap` does NOT
# perform scan-flop substitution -- it maps each internal D-FF onto the
# best-matching *ordinary* library flop (selected by clock/set/clear pins), so
# the output netlist contains non-scan cells such as
# `sky130_fd_sc_hd__dfrtp_1`, not the scan `sky130_fd_sc_hd__sdfxxx` mux-D
# cells. The real open-source scan-insertion path is Fault
# (https://github.com/AUCOHL/Fault), which sits downstream of Yosys synthesis
# and performs the scan-flop substitution and chain stitching that produce
# `sdf*` cells. This script captures only the Yosys-side preparation Fault
# expects: map all combinational gates to the Sky130 `sky130_fd_sc_hd` library
# and map every D-FF onto an ordinary library flop. Scan-flop retargeting and
# chain stitching are NOT done here; they are BLOCKED on Fault, which is not
# vendored under external/ (see docs/evidence/pd/dft-evidence.yaml).
#
# Usage from OpenLane (synthesis hook):
#
#     SYNTH_EXTRA_SCRIPT="pd/dft/scan_insertion.tcl"
#
# Or standalone from yosys (e.g., on a leaf module like e1_bootrom):
#
#     yosys -p "read_verilog -sv rtl/bootrom/e1_bootrom.sv; \
#               hierarchy -top e1_bootrom; \
#               synth -top e1_bootrom; \
#               source pd/dft/scan_insertion.tcl; \
#               write_verilog build/dft/e1_bootrom.scan_ready.v"

# Map all DFFs onto ordinary flops from the Sky130 high-density library.
# `dfflibmap` reads the typical-corner Liberty (provided by OpenLane via the
# LIB_TYPICAL environment variable) and selects the best-matching non-scan flop
# by `clock` + `set` / `clear` pin patterns; it does not retarget to scan
# (`sdf*`) cells. Fault's scan-flop substitution + chain stitching runs against
# this mapped netlist downstream.
dfflibmap -liberty $::env(LIB_TYPICAL_FAST_LIBERTY)

# Final tech mapping so the inserted scan muxes adopt the same standard
# cells as the rest of the design.
abc -liberty $::env(LIB_TYPICAL_FAST_LIBERTY)

# Final stats; emitted to the OpenLane log so the gate sees the cell delta.
stat
