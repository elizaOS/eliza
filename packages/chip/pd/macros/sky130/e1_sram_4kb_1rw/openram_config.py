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
# OpenRAM head (e16d9eb) tries to bootstrap its toolchain through a Nix flake
# unless this is False; the chip host uses the openram-miniconda EDA stack
# already on PATH (magic + ngspice + netgen + klayout from
# /home/shaw/.openram-miniconda/bin) so Nix is not available and not needed.
use_nix = False
nominal_corner_only = False
process_corners = ["TT", "SS", "FF"]
supply_voltages = [1.8]
temperatures = [25, 85, -40]

route_supplies = "ring"
# Inline LVS/DRC is disabled because Volare's sky130A magic techfile
# requires Magic 8.3.411 (Ambiguous layer name, Unrecognized layer name,
# Malformed device keyword errors below that). OpenRAM's bundled conda
# installer pins magic=8.3.363 which fails to load the techfile and aborts
# the bitcell_array LVS step. The generated LEF/GDS/Liberty/SPICE
# artifacts are verified externally with a newer Magic (the OpenLane2
# container ships 8.3.489) via scripts/check_openram_macro_drc.py.
check_lvsdrc = False
inline_lvsdrc = False

# Generate a square macro that AlphaChip and DREAMPlace can place flexibly.
# OpenRAM's hierarchical column decoder only ships predecoders for
# col_addr_size in {1, 2, 3, 4}; compiler/modules/column_decoder.py emits
# debug.error("Invalid column decoder?", -1) for anything outside that
# window (a previous attempt with words_per_row=64 -> col_addr_size=6 hit
# exactly that abort in build/e1_sram_4kb_1rw.log on 2026-05-19 17:33).
# words_per_row=16 -> col_addr_size=4 (predecode4x16) is the widest
# supported shape, giving 512 columns x 64 rows for 1024 words x 32 bits.
words_per_row = 16

# Sky130 OpenRAM tech requires (num_cols + num_ports + num_spare_cols) be
# divisible by array_col_multiple (= 2). With 32-bit word and 1 RW port that
# forces one spare column.
num_spare_cols = 1
num_spare_rows = 1

output_path = "pd/macros/sky130/e1_sram_4kb_1rw/build"
output_name = "e1_sram_4kb_1rw"
