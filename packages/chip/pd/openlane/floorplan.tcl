# e1 chip custom floorplan hooks
# Sourced by OpenLane 2 after the initial floorplan step when
# EXTRA_LEFS / EXTRA_MACROS are configured.
#
# Die:  2500 x 2500 um  (set in config.sky130.json DIE_AREA)
# Core: 2300 x 2300 um  with 100 um margins on all sides (CORE_AREA)
# PDK:  sky130A  sky130_fd_sc_hd
#
# This file is a scaffold.  Macro placement directives are commented out
# until SRAM macros are instantiated in the RTL and their LEF/LIB are
# available.  Enable them one block at a time and re-run global placement.

# ---------------------------------------------------------------------------
# Power connectivity (required before PDN generation)
# ---------------------------------------------------------------------------
add_global_connection -net VDD -pin_pattern {^VPB$}  -power
add_global_connection -net VDD -pin_pattern {^VPWR$} -power
add_global_connection -net VSS -pin_pattern {^VNB$}  -ground
add_global_connection -net VSS -pin_pattern {^VGND$} -ground

# ---------------------------------------------------------------------------
# Macro placement placeholders
# Uncomment and update origin/orient when macros are available.
# ---------------------------------------------------------------------------
# NPU scratchpad SRAM (future):
#   place_cell -inst u_soc/u_npu/u_sram -origin {200 200} -orient R0
#
# DMA buffer SRAM (future):
#   place_cell -inst u_soc/u_dma/u_sram -origin {200 800} -orient R0
#
# DRAM aperture macro (future):
#   place_cell -inst u_soc/u_dram/u_sram -origin {200 1400} -orient R0

# ---------------------------------------------------------------------------
# IO placement notes
# ---------------------------------------------------------------------------
# Pin order is controlled by pd/pin_order.cfg.
# The padframe contract is in pd/padframe/e1_demo_padframe.yaml.
# When IO ring cells are added, instantiate them in e1_chip_top and
# update this file with place_cell directives for corner cells.
