"""OpenRAM configuration for e1_sram_16kb_1rw on Sky130.

4096 words x 32 bits = 16 KB 1RW single-port SRAM. Intended for NPU weight
buffer scaffolds and L2 cache slice banks at 130 nm.
"""

word_size = 32
num_words = 4096
num_rw_ports = 1
num_r_ports = 0
num_w_ports = 0

tech_name = "sky130"
nominal_corner_only = False
process_corners = ["TT", "SS", "FF"]
supply_voltages = [1.8]
temperatures = [25, 85, -40]

route_supplies = "ring"
check_lvsdrc = True
inline_lvsdrc = True

# Roughly square aspect ratio for AlphaChip / DREAMPlace flexibility.
words_per_row = 128

output_path = "pd/macros/sky130/e1_sram_16kb_1rw/build"
output_name = "e1_sram_16kb_1rw"
