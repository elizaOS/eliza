set script_dir [file dirname [file normalize [info script]]]
set repo_dir [file normalize "$script_dir/../.."]

read_verilog "$repo_dir/build/netlist/e1_chip_synth.v"
link_design e1_chip_top
read_sdc "$repo_dir/pd/constraints/e1_soc.sdc"
report_checks
report_wns
report_tns
