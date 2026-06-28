create_clock -name clk -period 20.000 [get_ports CLK_IN]
set_clock_uncertainty 0.250 [get_clocks clk]
set data_inputs [get_ports {DBG_VALID DBG_WRITE DBG_ADDR* DBG_WDATA*}]
set_input_transition 0.250 $data_inputs
set_input_delay 2.000 -clock clk $data_inputs
set_output_delay 2.000 -clock clk [all_outputs]
set_load 0.050 [all_outputs]
set_false_path -from [get_ports RST_N]
