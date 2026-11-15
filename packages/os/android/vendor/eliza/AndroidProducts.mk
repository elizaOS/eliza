# elizaOS lunch targets.
#
# Cuttlefish: virtual phones, one emulator lane each for arm64 and x86_64.
# Pixel hardware: each device has its own pinned source/stock-input contract.
# GSI: system-only images for third-party Treble devices, built from the
#   gsi-android17 (cp2a) source profile. No GSI target is installer-eligible.
# Installer eligibility remains independently gated by hardware-targets.json
# and a retained real-device flash/boot evidence bundle.

PRODUCT_MAKEFILES := \
    $(LOCAL_DIR)/products/eliza_cf_arm64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_x86_64_phone.mk \
    $(LOCAL_DIR)/products/eliza_gsi_arm64.mk \
    $(LOCAL_DIR)/products/eliza_gsi_x86_64.mk

COMMON_LUNCH_CHOICES := \
    eliza_cf_arm64_phone-trunk_staging-userdebug \
    eliza_cf_x86_64_phone-trunk_staging-userdebug \
    eliza_gsi_arm64-cp2a-userdebug \
    eliza_gsi_x86_64-cp2a-userdebug
