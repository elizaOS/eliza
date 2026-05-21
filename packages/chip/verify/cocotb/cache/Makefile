include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/cache/cache_pkg.sv \
	$(REPO)/rtl/cache/ftq_to_l1i_pkg.sv \
	$(REPO)/rtl/cache/lsu_to_l1d_pkg.sv \
	$(REPO)/rtl/cache/l1i/e1_l1i_cache.sv \
	$(REPO)/rtl/cache/l1d/e1_l1d_cache.sv \
	$(REPO)/rtl/cache/l2/e1_l2_cache.sv \
	$(REPO)/rtl/cache/l3/e1_l3_cache.sv \
	$(REPO)/rtl/cache/slc/e1_slc.sv \
	$(REPO)/rtl/cache/prefetch/e1_berti_prefetcher.sv \
	$(REPO)/rtl/cache/prefetch/e1_fdip_l1i_prefetcher.sv \
	$(REPO)/rtl/cache/prefetch/e1_stride_prefetcher.sv \
	$(REPO)/rtl/cache/prefetch/e1_best_offset_prefetcher.sv \
	$(REPO)/rtl/cache/prefetch/e1_spp_prefetcher.sv \
	$(REPO)/rtl/cache/prefetch/e1_ipcp_prefetcher.sv \
	$(REPO)/rtl/cache/prefetch/e1_pythia_stub.sv \
	$(REPO)/rtl/cache/replacement/e1_drrip.sv \
	$(REPO)/rtl/cache/replacement/e1_hawkeye.sv \
	$(REPO)/rtl/cache/replacement/e1_mockingjay.sv \
	$(REPO)/rtl/cache/replacement/e1_mockingjay_prod.sv \
	$(REPO)/rtl/cache/compression/e1_bdi_compress.sv \
	$(REPO)/rtl/cache/compression/e1_bdi_decompress.sv \
	$(REPO)/rtl/cache/coherence/tl_c_to_chi_bridge.sv \
	$(PWD)/e1_l2_tb.sv \
	$(PWD)/e1_l3_tb.sv \
	$(PWD)/e1_slc_tb.sv \
	$(PWD)/e1_mockingjay_prod_tb.sv

TOPLEVEL ?= e1_l1i_cache
MODULE   ?= test_l1i_basic

EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-ASCRANGE -Wno-DECLFILENAME -Wno-VARHIDDEN -Wno-LATCH

include $(COCOTB_SIM_MK)
