# Pixel 9a (tegu), pinned by android/pixel9a.lock.json.
$(call inherit-product, device/google/tegu/aosp_tegu.mk)

PRODUCT_NAME := eliza_tegu_phone
PRODUCT_DEVICE := tegu
PRODUCT_MODEL := elizaOS Pixel 9a

# Set before inheriting eliza_common.mk so the image carries its exact product.
ELIZA_PRODUCT_TAG := eliza_tegu_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
