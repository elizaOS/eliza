# ElizaOS lunch targets.
#
# Cuttlefish: virtual phones. x86_64 is validated end-to-end via
#   `bun run elizaos:e2e` after `cvd start --daemon`. riscv64 follows the
#   same shape (vsoc_riscv64_only); the boot transcript is gated on a
#   Linux x86_64 build host — see chip/docs/android/cuttlefish-riscv64-bringup.md.
# Pixel codenames: real-device targets. Each per-codename wrapper sets
#   ELIZA_PIXEL_CODENAME and inherits products/eliza_pixel_phone.mk.
#   The wrapper file must exist for `lunch` to surface the target;
#   add new codenames by creating products/eliza_<codename>_phone.mk
#   and listing it under PRODUCT_MAKEFILES + COMMON_LUNCH_CHOICES below.

PRODUCT_MAKEFILES := \
    $(LOCAL_DIR)/products/eliza_cf_x86_64_phone.mk \
    $(LOCAL_DIR)/products/eliza_cf_riscv64_phone.mk \
    $(LOCAL_DIR)/products/eliza_oriole_phone.mk \
    $(LOCAL_DIR)/products/eliza_panther_phone.mk \
    $(LOCAL_DIR)/products/eliza_shiba_phone.mk \
    $(LOCAL_DIR)/products/eliza_caiman_phone.mk \
    $(LOCAL_DIR)/products/eliza_tegu_phone.mk \
    $(LOCAL_DIR)/products/eliza_openagent_ai_soc_phone.mk

COMMON_LUNCH_CHOICES := \
    eliza_cf_x86_64_phone-trunk_staging-userdebug \
    eliza_cf_riscv64_phone-trunk_staging-userdebug \
    eliza_oriole_phone-trunk_staging-userdebug \
    eliza_panther_phone-trunk_staging-userdebug \
    eliza_shiba_phone-trunk_staging-userdebug \
    eliza_caiman_phone-trunk_staging-userdebug \
    eliza_tegu_phone-trunk_staging-userdebug \
    eliza_openagent_ai_soc_phone-trunk_staging-userdebug
