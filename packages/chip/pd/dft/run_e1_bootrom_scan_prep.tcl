# Standalone TCL driver: synthesizes e1_bootrom, runs scan-prep, writes
# scan-ready Verilog. Used to validate pd/dft/scan_insertion.tcl on a real
# leaf module without spinning up the full OpenLane release flow.
#
# Required env var:
#   LIB_TYPICAL_FAST_LIBERTY - absolute path to a Sky130 sky130_fd_sc_hd
#                              typical-corner Liberty file.
#
# Usage:
#   LIB=external/pdks/volare/sky130/versions/0fe599b2afb6708d281543108caf8310912f54af/sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
#   PATH=external/oss-cad-suite/bin:$PATH \
#     LIB_TYPICAL_FAST_LIBERTY=$PWD/$LIB \
#     yosys -c pd/dft/run_e1_bootrom_scan_prep.tcl

yosys -import
read_verilog -sv rtl/bootrom/e1_bootrom.sv
hierarchy -top e1_bootrom
synth -top e1_bootrom
yosys -import
source pd/dft/scan_insertion.tcl
exec mkdir -p build/dft
write_verilog build/dft/e1_bootrom.scan_ready.v
