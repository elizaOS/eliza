$(call inherit-product, device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk)

PRODUCT_NAME := eliza_cf_x86_64_phone
PRODUCT_DEVICE := vsoc_x86_64_only
PRODUCT_MODEL := ElizaOS Cuttlefish Phone

# Set before inheriting eliza_common.mk so the brand property can pin
# this image to its lunch target.
ELIZA_PRODUCT_TAG := eliza_cf_x86_64_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
