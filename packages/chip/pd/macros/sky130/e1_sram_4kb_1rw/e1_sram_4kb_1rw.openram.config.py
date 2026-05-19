"""OpenRAM configuration for e1_sram_4kb_1rw on Sky130.

1024 words x 32 bits = 4 KB 1RW single-port SRAM. Intended for CPU L1
data/instruction cache banks at 130 nm. Generated artifacts (LEF/GDS/Liberty/
SPICE) land alongside this config and feed pd/macros/manifest.yaml after
verification.

Run with:

    python3 $OPENRAM_HOME/openram.py \\
        pd/macros/sky130/e1_sram_4kb_1rw/e1_sram_4kb_1rw.openram.config.py
"""

word_size = 32
num_words = 1024
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

# Generate a square macro that AlphaChip and DREAMPlace can place flexibly.
words_per_row = 64

output_path = "pd/macros/sky130/e1_sram_4kb_1rw/build"
output_name = "e1_sram_4kb_1rw"
