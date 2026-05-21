include ../common.mk

# E1 root-of-trust integration top (W1). Packages first, then the W4 OTP
# controller and the RoT spine (reset sequencer, mailbox, crypto shims, top),
# then the cocotb testbench wrapper. The RoT Ibex is NOT instantiated for the
# reset-release + mailbox cocotb contracts (E1_ROT_INSTANTIATE_IBEX is left
# undefined); the Ibex-instantiated elaboration is checked by
# scripts/check_rot_integration.py.
VERILOG_SOURCES := \
	$(REPO)/rtl/security/rot/e1_rot_tlul_pkg.sv \
	$(REPO)/rtl/security/otp/e1_otp_map.sv \
	$(REPO)/rtl/security/rot/e1_rot_crypto_shim.sv \
	$(REPO)/rtl/security/rot/e1_rot_mailbox.sv \
	$(REPO)/rtl/security/rot/e1_rot_reset_seq.sv \
	$(REPO)/rtl/security/rot/e1_rot_top.sv \
	$(PWD)/e1_rot_top_tb.sv

TOPLEVEL ?= e1_rot_top_tb
MODULE   ?= test_e1_rot_top

# The test module lives at verify/cocotb/test_e1_rot_top.py (one level up, the
# path the W1 deliverable specifies). Put that directory on PYTHONPATH so cocotb
# imports it.
export PYTHONPATH := $(REPO)/verify/cocotb:$(PYTHONPATH)

# Package public constants (TL_D2H_DEFAULT) are intentionally not all consumed
# by every instance; PINCONNECTEMPTY covers the deliberately-unconnected
# observability pin on the standalone round-trip mailbox.
EXTRA_ARGS += -Wno-UNUSEDPARAM -Wno-PINCONNECTEMPTY

include $(COCOTB_SIM_MK)
