# E1X3D tile timing constraints — ASAP7 predictive 7 nm FinFET shape lane
# Target: 1.5 ns period (~667 MHz) FinFET-class PPA shape on ASAP7 (asap7sc7p5t_rvt)
# Top-level: e1x3d_tile   Clock port: clk_i   Reset port: rst_ni (active low)
#
# ASAP7 is an academic predictive PDK: timing here is a FinFET-class shape, not
# foundry signoff. Numbers feed scripts/project_ppa_to_n2p.py only, never a
# TSMC N2P / A14 / Intel 14A signoff claim.

set_units -time ns -resistance kOhm -capacitance pF -voltage V -current mA

create_clock -name clk -period 1.5 [get_ports clk_i]
set_clock_uncertainty 0.05 [get_clocks clk]
set_clock_transition  0.02 [get_clocks clk]

# Loose, uniform IO budget. Every primary input/output is registered through the
# 3D router/core, so ~20% of the 1.5 ns period as a max IO delay leaves ample
# slack while still constraining the boundary against the fast FinFET corner.
set non_clock_inputs [remove_from_collection [all_inputs] [get_ports clk_i]]
set_input_delay  -clock clk -max 0.30 $non_clock_inputs
set_input_delay  -clock clk -min 0.10 $non_clock_inputs
set_output_delay -clock clk -max 0.30 [all_outputs]
set_output_delay -clock clk -min 0.10 [all_outputs]
set_driving_cell -lib_cell BUFx4_ASAP7_75t_R -pin Y $non_clock_inputs
set_input_transition 0.04 $non_clock_inputs
set_load 0.005 [all_outputs]

# Active-low reset is an asynchronous, statically-asserted boundary input; do not
# time it against the functional clock.
set_false_path -from [get_ports rst_ni]
