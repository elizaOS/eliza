# E1X3D 3D fabric router timing constraints — ASAP7 predictive 7 nm FinFET lane.
# Target: 1.5 ns period (~667 MHz). OpenSTA-compatible (no remove_from_collection).
# Top-level: e1x3d_router7   Clock port: clk_i   Reset port: rst_ni (active low)
#
# ASAP7 is an academic predictive PDK: timing here is a FinFET-class shape, not
# foundry signoff. The clock transition is re-pinned after the data driving cell
# so the clock waveform is not perturbed.

set_units -time ns -resistance kOhm -capacitance pF -voltage V -current mA

create_clock -name clk -period 1.5 [get_ports clk_i]
set_clock_uncertainty 0.05 [get_clocks clk]

set_input_delay  -clock clk -max 0.30 [all_inputs]
set_input_delay  -clock clk -min 0.10 [all_inputs]
set_output_delay -clock clk -max 0.30 [all_outputs]
set_output_delay -clock clk -min 0.10 [all_outputs]
set_driving_cell -lib_cell BUFx4_ASAP7_75t_R -pin Y [all_inputs]
set_input_transition 0.04 [all_inputs]
set_load 0.005 [all_outputs]
set_clock_transition 0.02 [get_clocks clk]

# Active-low async reset boundary input; not timed against the functional clock.
set_false_path -from [get_ports rst_ni]
