# TritonCTS strategy bundle for the e1 OpenROAD release flow.
#
# This is the MVP CTS pass at open PDKs. It builds an H-tree per clock root
# with a uniform skew target. At the advanced node (Stage 3) this is replaced
# by CCOpt-equivalent concurrent clock-data optimization plus a mesh + leaf
# H-tree hybrid; see pd/cts/README.md.

# Per-clock root configuration. CLK_IN is the single domain on the current
# release; the bootrom and JTAG TAP run from the same root under a divider.
set ::env(CTS_CLK_BUFFER_LIST) "sky130_fd_sc_hd__clkbuf_4 sky130_fd_sc_hd__clkbuf_8 sky130_fd_sc_hd__clkbuf_16"
set ::env(CTS_ROOT_BUFFER)     "sky130_fd_sc_hd__clkbuf_16"
set ::env(CTS_TOLERANCE)       100
set ::env(CTS_TARGET_SKEW)     200
set ::env(CTS_DISABLE_POST_OPT) 0
set ::env(CTS_DISTANCE_BETWEEN_BUFFERS) 100

# Trigger TritonCTS with a uniform target slew so the resulting tree behaves
# predictably across the SS/TT/FF corners exercised by run_multi_corner_sta.py.
clock_tree_synthesis \
    -buf_list "$::env(CTS_CLK_BUFFER_LIST)" \
    -root_buf "$::env(CTS_ROOT_BUFFER)" \
    -wire_unit 20 \
    -clk_nets {clk}

# Report skew/insertion-delay digest into the OpenLane reports directory so
# the cts-evidence gate can pick it up.
report_cts -out_file [file join $::env(REPORTS_DIR) "cts_summary.rpt"]
