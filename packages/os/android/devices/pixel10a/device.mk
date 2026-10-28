# Alpha hardware composition on Eliza AOSP, using verified stallion stock inputs.
# Adapted from adevtool 17df3b79a73e67ad68387b35c7d41c85e1d8103c's
# stallion, zumapro, and gs201-plus device configurations.
$(call inherit-product, vendor/adevtool/config/mk/google_devices/platform/zumapro/product-common.mk)

TARGET_BOARD_PLATFORM := zumapro
TARGET_KERNEL_DIR := vendor/google_devices/stallion/stock-kernel
include vendor/alphaphone/stallion/device-common.mk

$(call inherit-product, $(SRC_TARGET_DIR)/product/virtual_ab_ota/android_t_baseline.mk)
PRODUCT_VIRTUAL_AB_COMPRESSION_METHOD := lz4
PRODUCT_BUILD_VENDOR_KERNEL_BOOT_IMAGE := true
$(call inherit-product, $(SRC_TARGET_DIR)/product/core_64_bit_only.mk)

PRODUCT_SOONG_NAMESPACES += vendor/adevtool/config/mk/google_devices/platform/zumapro
AB_OTA_POSTINSTALL_CONFIG += FILESYSTEM_TYPE_system=ext4
TRUSTY_KEYMINT_IMPL := rust

# GosOverlay targets resources absent from the AOSP framework. Generated stock
# overlays remain selected by stallion.mk; no Graphene framework flags are added.
PRODUCT_PACKAGES += init.zumapro.grapheneos.rc
PRODUCT_PACKAGES += AlphaPixelConfig
PRODUCT_CHECK_VENDOR_SEAPP_VIOLATIONS := true
PRODUCT_CHECK_DEV_TYPE_VIOLATIONS := true
PRODUCT_NO_BIONIC_PAGE_SIZE_MACRO := true
