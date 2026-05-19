# Yosys scan-chain insertion pass for e1_chip_top.
#
# Yosys ships the `scanchain` pass which converts every D-FF in the design
# into a scan-equivalent cell driven by a top-level scan_in/scan_en/scan_out
# trio. We append it to the synthesis pipeline so the OpenLane release flow
# produces a scan-enabled netlist that Fault (academic ATPG) or commercial
# Tetramax can consume.
#
# Usage from OpenLane (synthesis hook):
#
#     SYNTH_EXTRA_SCRIPT="pd/dft/scan_insertion.tcl"
#
# Or standalone from yosys:
#
#     yosys -p "read_verilog -sv rtl/top/e1_chip_top.sv; \
#               hierarchy -top e1_chip_top; \
#               synth -top e1_chip_top; \
#               source pd/dft/scan_insertion.tcl; \
#               write_verilog build/dft/e1_chip_top.scan.v"

# Conservative single-chain configuration. Multi-chain balancing happens
# at the post-synth, pre-place stage via a commercial flow; on the open
# tooling we keep one long chain so Fault can ingest the SDF deterministically.
scanchain \
    -clk           CLK_IN \
    -rst           RESET_N \
    -rst-pol       0 \
    -ce            scan_en \
    -in            scan_in \
    -out           scan_out

# Re-run technology mapping so the inserted scan muxes adopt the same
# standard cells the rest of the design uses. Sky130 high-density library
# is the default; if a different library is selected via LIB_PATH the
# downstream OpenLane flow will replace this pass.
abc -liberty $::env(LIB_TYPICAL_FAST_LIBERTY)

# Final stats; emitted to the OpenLane log so the gate sees the cell delta.
stat
