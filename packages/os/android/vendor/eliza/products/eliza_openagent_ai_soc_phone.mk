# Fused product: OpenAgent E1 RISC-V AI SoC + elizaOS system-assistant overlay.
#
# The base device tree (board config, kernel cmdline, init.rc, sepolicy,
# VINTF manifests, NPU HAL fragments) comes from the chip team's
# `device/eliza/eliza_ai_soc/` tree, imported into the AOSP checkout by
# `packages/chip/sw/aosp-device/import-aosp-device.sh`. The Eliza common
# product layer is inherited AFTER the device makefile so the privileged
# Eliza APK, default-role strips, framework overlay, init.eliza.rc, and
# assistant/full-control manifest override the AOSP defaults pulled in
# transitively by `aosp_base.mk`.
#
# If `device/eliza/eliza_ai_soc/eliza_ai_soc.mk` is missing, the build
# fails loudly on the `inherit-product` below — that is the intended
# signal that the chip device tree has not been imported into this AOSP
# checkout yet. Do not add a guard or fallback.

$(call inherit-product, device/eliza/eliza_ai_soc/eliza_ai_soc.mk)

PRODUCT_NAME := eliza_openagent_ai_soc_phone
PRODUCT_DEVICE := eliza_ai_soc
PRODUCT_MODEL := elizaOS Phone (OpenAgent E1)

# Pinned before inheriting eliza_common.mk so ro.elizaos.product reflects
# this lunch target on the running image.
ELIZA_PRODUCT_TAG := eliza_openagent_ai_soc_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
