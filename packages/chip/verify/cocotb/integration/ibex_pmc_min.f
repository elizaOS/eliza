# -----------------------------------------------------------------------------
# Eliza E1 — Ibex sources required to elaborate `ibex_top` from rtl/power/
# pmc_top.sv under +define+PMC_INSTANTIATE_IBEX.
#
# Source paths point into the FuseSoC-resolved tree under
#   external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src
# This tree is produced by `scripts/bootstrap_ibex.sh` followed by the
# upstream Ibex `make build-simple-system` invocation that R5 ran; the
# tree is reproducible from the pinned upstream SHA in
# external/ibex/pin-manifest.json. We depend on the resolved tree because
# the upstream files use vendored copies (vendor/lowrisc_ip/...) that
# FuseSoC stages with the lint waivers + include-path layout Verilator
# expects.
#
# This file is consumed by verify/cocotb/integration/Makefile when
# PMC_INSTANTIATE_IBEX=1 is set in the environment.
# -----------------------------------------------------------------------------

# Include paths (prim_assert.sv + macro headers are referenced from many
# of the prim cells; without these on the include path the `ASSERT*
# macros expand to nothing valid).
+incdir+external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_assert_0.1/rtl
+incdir+external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl
+incdir+external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_util_memload_0/rtl
+incdir+external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_util_get_scramble_params_0/rtl
+incdir+external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_dv_dv_fcov_macros_0
+incdir+external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_dv_secded_enc_0

# Packages — must precede modules that import them.
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_pkg_0.1/rtl/ibex_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_ram_1p_pkg_0/rtl/prim_ram_1p_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_ram_2p_pkg_0/rtl/prim_ram_2p_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_rom_pkg_0/rtl/prim_rom_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_cipher_pkg_0.1/rtl/prim_cipher_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_pad_wrapper_pkg_0/rtl/prim_pad_wrapper_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_count_0/rtl/prim_count_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_pkg_0.1/rtl/prim_mubi_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_prim_pkg_0/rtl/prim_pkg.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_util_0.1/rtl/prim_util_pkg.sv

# Generic prim cells.
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_and2_0/rtl/prim_and2.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_buf_0/rtl/prim_buf.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_clock_buf_0/rtl/prim_clock_buf.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_clock_gating_0/rtl/prim_clock_gating.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_clock_inv_0/rtl/prim_clock_inv.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_clock_mux2_0/rtl/prim_clock_mux2.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_clock_div_0/rtl/prim_clock_div.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_flop_0/rtl/prim_flop.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_flop_2sync_0/rtl/prim_flop_2sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_flop_en_0/rtl/prim_flop_en.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_flop_no_rst_0/rtl/prim_flop_no_rst.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_pad_attr_0/rtl/prim_pad_attr.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_pad_wrapper_0/rtl/prim_pad_wrapper.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_ram_1r1w_0/rtl/prim_ram_1r1w.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_rom_0/rtl/prim_rom.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_rst_sync_0/rtl/prim_rst_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_usb_diff_rx_0/rtl/prim_usb_diff_rx.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_xnor2_0/rtl/prim_xnor2.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_generic_xor2_0/rtl/prim_xor2.sv

# SECDED encoder/decoder bank (used by integrity ports we tie off).
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_22_16_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_22_16_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_28_22_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_28_22_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_39_32_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_39_32_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_64_57_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_64_57_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_72_64_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_72_64_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_22_16_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_22_16_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_39_32_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_39_32_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_72_64_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_72_64_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_76_68_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_hamming_76_68_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_22_16_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_22_16_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_28_22_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_28_22_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_39_32_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_39_32_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_64_57_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_64_57_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_72_64_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_72_64_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_22_16_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_22_16_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_39_32_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_39_32_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_72_64_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_72_64_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_76_68_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_secded_0.1/rtl/prim_secded_inv_hamming_76_68_enc.sv

# Other prims used by ibex_top + lockstep stubs.
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_cdc_rand_delay_0/rtl/prim_cdc_rand_delay.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_cipher_0/rtl/prim_subst_perm.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_cipher_0/rtl/prim_present.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_cipher_0/rtl/prim_prince.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_count_0/rtl/prim_count.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_lfsr_0.1/rtl/prim_lfsr.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_sec_anchor_0.1/rtl/prim_sec_anchor_buf.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_sec_anchor_0.1/rtl/prim_sec_anchor_flop.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi4_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi4_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi4_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi8_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi8_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi8_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi12_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi12_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi12_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi16_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi16_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi16_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi20_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi20_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi20_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi24_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi24_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi24_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi28_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi28_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi28_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi32_sender.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi32_sync.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_mubi_0.1/rtl/prim_mubi32_dec.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_onehot_0/rtl/prim_onehot_enc.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_onehot_0/rtl/prim_onehot_mux.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_onehot_check_0/rtl/prim_onehot_check.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_ram_1p_adv_0.1/rtl/prim_ram_1p_adv.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_prim_ram_1p_scr_0.1/rtl/prim_ram_1p_scr.sv

# Ibex core RTL.
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_alu.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_branch_predict.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_compressed_decoder.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_controller.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_cs_registers.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_csr.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_counter.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_decoder.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_ex_block.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_fetch_fifo.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_id_stage.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_if_stage.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_load_store_unit.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_multdiv_fast.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_multdiv_slow.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_prefetch_buffer.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_pmp.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_wb_stage.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_dummy_instr.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_core_0.1/rtl/ibex_core.sv

# Ibex top + register file flavours + lockstep helper.
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_top_0.1/rtl/ibex_register_file_ff.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_top_0.1/rtl/ibex_register_file_fpga.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_top_0.1/rtl/ibex_register_file_latch.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_top_0.1/rtl/ibex_lockstep.sv
external/ibex/ibex/build/lowrisc_ibex_ibex_simple_system_0/sim-verilator/src/lowrisc_ibex_ibex_top_0.1/rtl/ibex_top.sv
