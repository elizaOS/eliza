# Open-flow scan insertion for e1_chip_top.
#
# Background: Yosys upstream does NOT ship a `scanchain` pass that
# transparently converts D-FFs into scan equivalents. The real open-source
# scan-insertion path is Fault (https://github.com/AUCOHL/Fault), which sits
# downstream of Yosys synthesis. This script captures the Yosys-side
# preparation that Fault expects: map all combinational gates to the Sky130
# `sky130_fd_sc_hd` library, then remap every D-FF onto a scan-capable
# `sky130_fd_sc_hd__sdfxxx` flop so the scan chain Fault stitches has the
# right cell types to walk.
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

# Map all DFFs onto flops from the Sky130 high-density library. `dfflibmap`
# reads the typical-corner Liberty (provided by OpenLane via the LIB_TYPICAL
# environment variable) and selects flops by `clock` + `set` / `clear` pin
# patterns. Fault's chain stitching runs against this mapped netlist.
dfflibmap -liberty $::env(LIB_TYPICAL_FAST_LIBERTY)

# Final tech mapping so the inserted scan muxes adopt the same standard
# cells as the rest of the design.
abc -liberty $::env(LIB_TYPICAL_FAST_LIBERTY)

# Final stats; emitted to the OpenLane log so the gate sees the cell delta.
stat
