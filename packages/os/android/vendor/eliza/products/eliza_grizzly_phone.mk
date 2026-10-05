# Pixel 11 Pro (grizzly), generated from the source and stock-image contract in
# android/pixel11pro.lock.json.
#
# Keep the stock Pixel kernel for the first hardware bring-up. The public
# spacecraft kernel source is not yet available, while adevtool extracts the
# matching kernel, modules, DTB, and DTBO from the pinned reference image.
USE_STOCK_KERNEL := true
$(call inherit-product, vendor/google_devices/grizzly/grizzly.mk)

PRODUCT_NAME := eliza_grizzly_phone
PRODUCT_DEVICE := grizzly
PRODUCT_MODEL := elizaOS Pixel 11 Pro

ELIZA_PRODUCT_TAG := eliza_grizzly_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
