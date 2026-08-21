"""OpenRAM configuration for e1_sram_4kb_1rw on Sky130.

1024 words x 32 bits = 4 KB 1RW single-port SRAM. Intended for CPU L1
data/instruction cache banks at 130 nm. Generated artifacts (LEF/GDS/Liberty/
SPICE) land under build/ and feed pd/macros/manifest.yaml after verification.

Build with:

    pd/macros/sky130/build_openram_macro.sh pd/macros/sky130/e1_sram_4kb_1rw
"""

word_size = 32
num_words = 1024
num_rw_ports = 1
num_r_ports = 0
num_w_ports = 0

tech_name = "sky130"
# OpenRAM head (e16d9eb) bootstraps its toolchain through a Nix flake unless
# this is False; the chip host uses the openram-miniconda EDA stack already on
# PATH (magic + ngspice + netgen + klayout), so Nix is neither available nor
# needed.
use_nix = False
nominal_corner_only = False
process_corners = ["TT", "SS", "FF"]
supply_voltages = [1.8]
temperatures = [25, 85, -40]

route_supplies = "ring"
# Inline LVS/DRC is disabled because the openram-miniconda Magic (8.3.363)
# cannot load Volare's sky130A magic techfile (needs 8.3.411+: Ambiguous /
# Unrecognized layer name, Malformed device keyword). The generated GDS is
# verified afterwards with native Magic 8.3.645 via
# scripts/check_openram_macro_drc.py.
check_lvsdrc = False
inline_lvsdrc = False

# words_per_row is constrained by OpenRAM's hierarchical column decoder, which
# only ships predecoders for col_addr_size in {1, 2, 3, 4}
# (compiler/modules/column_decoder.py raises "Invalid column decoder?"
# otherwise). col_addr_size = log2(words_per_row), so words_per_row=16 (the
# widest supported, predecode4x16) gives 512 columns x 64 rows for
# 1024 words x 32 bits.
words_per_row = 16

# Sky130 tech requires (num_cols + num_ports + num_spare_cols) divisible by
# array_col_multiple (= 2). With a 32-bit word and 1 RW port that forces one
# spare column.
num_spare_cols = 1
num_spare_rows = 1

output_path = "pd/macros/sky130/e1_sram_4kb_1rw/build"
output_name = "e1_sram_4kb_1rw"
