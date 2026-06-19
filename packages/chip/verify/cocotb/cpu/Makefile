include ../common.mk

# RVV 1.0 element-wise ALU subset DUT. The CSR package (rvv_pkg) is compiled
# in for the vtype_t struct + sew/lmul enums consumed by the ALU.
VERILOG_SOURCES := \
	$(REPO)/rtl/cpu/rvv/rvv_csr.sv \
	$(REPO)/rtl/cpu/rvv/rvv_alu_subset.sv

TOPLEVEL ?= rvv_alu_subset
MODULE   ?= test_rvv_alu_subset

include $(COCOTB_SIM_MK)
