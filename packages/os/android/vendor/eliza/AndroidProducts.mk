# elizaOS lunch targets.
#
# Cuttlefish: virtual phones. arm64, x86_64, and riscv64 are all declared so
#   the elizaOS AOSP fork has explicit emulator lanes for each supported ABI.
#   riscv64 boot transcripts are gated on a Linux x86_64 build host. External
#   chip simulators require their own pinned product and source lock.
# Pixel hardware: each device has its own pinned source/stock-input contract.
# Installer eligibility remains independently gated by hardware-targets.json
# and a retained real-device flash/boot evidence bundle.

PRODUCT_MAKEFILES := \
    $(LOCAL_DIR)/products/eliza_cf_arm64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_x86_64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_riscv64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_riscv64_e1_phone.mk \
    $(LOCAL_DIR)/products/eliza_tegu_phone.mk \
    $(LOCAL_DIR)/products/eliza_grizzly_phone.mk

COMMON_LUNCH_CHOICES := \
    eliza_cf_arm64_phone-trunk_staging-userdebug \
    eliza_cf_x86_64_phone-trunk_staging-userdebug \
    eliza_cf_riscv64_phone-trunk_staging-userdebug \
    eliza_cf_riscv64_e1_phone-trunk_staging-userdebug \
    eliza_tegu_phone-trunk_staging-userdebug \
    eliza_grizzly_phone-trunk_staging-userdebug
