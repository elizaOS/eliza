$(call inherit-product, device/google/cuttlefish/vsoc_arm64/phone/aosp_cf.mk)

PRODUCT_SOONG_DEFINED_SYSTEM_IMAGE := eliza_aosp_shared_system_image

PRODUCT_NAME := eliza_cf_arm64_phone
PRODUCT_DEVICE := vsoc_arm64
PRODUCT_MODEL := elizaOS Cuttlefish Phone (ARM64)

# Set before inheriting eliza_common.mk so the brand property can pin
# this image to its lunch target.
ELIZA_PRODUCT_TAG := eliza_cf_arm64_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
