# E1X3D tile timing constraints
# Target: 10 MHz open-PDK signoff trial on SKY130A (100 ns period)
# Top-level: e1x3d_tile   Clock port: clk_i   Reset port: rst_ni

set_units -time ns -resistance kOhm -capacitance pF -voltage V -current mA

create_clock -name clk -period 100.0 [get_ports clk_i]
set_clock_uncertainty 0.5  [get_clocks clk]
set_clock_transition  0.15 [get_clocks clk]

# Loose, uniform IO budget: every primary input/output is registered through the
# 3D router/core at a 100 ns period, so a 2 ns IO delay leaves ample slack while
# still constraining the boundary.
set non_clock_inputs [remove_from_collection [all_inputs] [get_ports clk_i]]
set_input_delay  -clock clk -max 2.0 $non_clock_inputs
set_input_delay  -clock clk -min 1.0 $non_clock_inputs
set_output_delay -clock clk -max 2.0 [all_outputs]
set_output_delay -clock clk -min 1.0 [all_outputs]
set_driving_cell -lib_cell sky130_fd_sc_hd__buf_4 -pin X $non_clock_inputs
set_input_transition 0.25 $non_clock_inputs
