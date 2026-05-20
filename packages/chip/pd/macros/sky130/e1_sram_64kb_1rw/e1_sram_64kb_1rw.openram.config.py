"""OpenRAM configuration for e1_sram_64kb_1rw on Sky130.

16384 words x 32 bits = 64 KB 1RW single-port SRAM. Intended for L3 cache
slice scaffolds and NPU activation buffers at 130 nm. This is the largest
macro in the e1 OpenRAM pipeline; building it produces the macro that makes
AlphaChip macro placement non-trivial because its area dominates the
floorplan.
"""

word_size = 32
num_words = 16384
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

# Wider than tall keeps wordline RC manageable at this depth on Sky130 mid
# metal stacks.
words_per_row = 256

output_path = "pd/macros/sky130/e1_sram_64kb_1rw/build"
output_name = "e1_sram_64kb_1rw"
