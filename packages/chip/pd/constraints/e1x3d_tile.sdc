# E1X3D timing constraints (OpenSTA-compatible; shared by the e1x3d tile and
# router PD configs). Target: 10 MHz open-PDK signoff trial on SKY130A (100 ns).
# Clock port: clk_i   Reset port: rst_ni
#
# Uses only OpenSTA-supported commands (no remove_from_collection / PrimeTime
# collection ops). A uniform, loose IO budget at a 100 ns period leaves ample
# slack while still constraining the boundary.

set_units -time ns -resistance kOhm -capacitance pF -voltage V -current mA

create_clock -name clk -period 100.0 [get_ports clk_i]
set_clock_uncertainty 0.5  [get_clocks clk]
set_clock_transition  0.15 [get_clocks clk]

set_input_delay  -clock clk -max 2.0 [all_inputs]
set_input_delay  -clock clk -min 1.0 [all_inputs]
set_output_delay -clock clk -max 2.0 [all_outputs]
set_output_delay -clock clk -min 1.0 [all_outputs]

# Give the boundary a realistic driver, input transition, and output load so the
# wide (~1000-pin) primary IO does not present unbounded slew to the first/last
# logic level (which otherwise shows up as thousands of max-slew violations the
# resizer cannot anchor). OpenSTA-safe; the clock transition below is re-pinned
# after so the clock waveform is not perturbed by the data driving cell.
set_driving_cell -lib_cell sky130_fd_sc_hd__buf_4 -pin X [all_inputs]
set_input_transition 0.15 [all_inputs]
set_load 0.05 [all_outputs]
set_clock_transition 0.15 [get_clocks clk]
