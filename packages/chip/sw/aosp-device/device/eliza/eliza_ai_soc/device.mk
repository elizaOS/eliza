# Device makefile for the Eliza e1 AI SoC AOSP target.
#
# HAL implementation source lives under:
#   device/eliza/eliza_ai_soc/hal/
#
# Hardware register layout source of truth:
#   sw/platform/e1_platform_contract.json

PRODUCT_DEVICE := eliza_ai_soc
PRODUCT_NAME := eliza_ai_soc
PRODUCT_BRAND := Eliza
PRODUCT_MODEL := Eliza e1 AI SoC
PRODUCT_MANUFACTURER := Eliza

# Init, fstab, VINTF manifest.
PRODUCT_COPY_FILES += \
    device/eliza/eliza_ai_soc/init.eliza.rc:$(TARGET_COPY_OUT_VENDOR)/etc/init/init.eliza.rc \
    device/eliza/eliza_ai_soc/fstab.eliza:$(TARGET_COPY_OUT_VENDOR)/etc/fstab.eliza

# HAL service binaries.
#
# Future integration points:
#   android.hardware.graphics.composer@2.4-service
#   hwcomposer.eliza_ai_soc
#   vendor.eliza.e1_npu@1.0-service
# HAL package names are intentionally not listed until source or prebuilts are
# imported into the external AOSP tree. Keeping these out of PRODUCT_PACKAGES
# prevents vendorimage from passing with misleading, unimplemented services.
#
# Future external-tree packages:
#   hwcomposer.eliza_ai_soc
#   e1_npu.default
#
# WiFi/Bluetooth packages, permissions, overlays, supplicant/hostapd configs,
# and Android feature XML are intentionally absent until the external module
# has host-controller, firmware, regulatory, and framework evidence.

PRODUCT_VENDOR_PROPERTIES += \
    vendor.eliza.soc.manufacturer=Eliza \
    vendor.eliza.soc.model=eliza_ai_soc \
    vendor.e1_npu.ready=0 \
    ro.hardware.hwcomposer=eliza \
    ro.hardware.gralloc=eliza
