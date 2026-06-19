# e1_soc timing constraints
# Target: 10 MHz OpenLane trial on SKY130A (100 ns period)
# Top-level: e1_chip_top
# Clock port: CLK_IN   Reset port: RST_N

set_units -time ns -resistance kOhm -capacitance pF -voltage V -current mA

# ---------------------------------------------------------------------------
# Primary clock
# ---------------------------------------------------------------------------
create_clock -name clk -period 100.0 [get_ports CLK_IN]
set_clock_uncertainty 0.5  [get_clocks clk]
set_clock_transition  0.15 [get_clocks clk]

# ---------------------------------------------------------------------------
# Input delays — assume external data arrives 2 ns after rising clock edge
# Exclude the clock port itself and the asynchronous reset
# ---------------------------------------------------------------------------
set data_inputs [get_ports {DBG_VALID DBG_LAUNCH DBG_WRITE DBG_ADDR* DBG_WDATA* TEST_MODE JTAG_TCK JTAG_TMS JTAG_TDI}]
set_input_delay -clock clk -max 2.0 \
    $data_inputs
set_input_delay -clock clk -min 2.0 \
    $data_inputs

# Driving-cell model for external input transitions (sky130_fd_sc_hd buf_4)
set_driving_cell -lib_cell sky130_fd_sc_hd__buf_4 -pin X \
    $data_inputs

# Input transition on the debug nibble bus
set_input_transition 0.25 [get_ports {DBG_VALID DBG_LAUNCH DBG_WRITE DBG_ADDR* DBG_WDATA*}]

# ---------------------------------------------------------------------------
# Output delays — outputs must be stable 2 ns before next rising clock edge
# ---------------------------------------------------------------------------
set_output_delay -clock clk -max 2.0 [all_outputs]
set_output_delay -clock clk -min 0.5 [all_outputs]
set_load 0.05 [all_outputs]

# ---------------------------------------------------------------------------
# False paths
# ---------------------------------------------------------------------------
# Asynchronous reset — async assert, synchronised deassert inside e1_reset_sync
set_false_path -from [get_ports RST_N]

# Static test/JTAG ports — not in the synchronous data path
set_false_path -from [get_ports TEST_MODE]
set_false_path -from [get_ports {JTAG_TCK JTAG_TMS JTAG_TDI}]
set_false_path -to   [get_ports JTAG_TDO]
