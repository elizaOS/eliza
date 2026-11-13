$(call inherit-product, $(SRC_TARGET_DIR)/product/aosp_arm64.mk)
$(call inherit-product, $(SRC_TARGET_DIR)/product/gsi_release.mk)

MODULE_BUILD_FROM_SOURCE ?= true

PRODUCT_NAME := eliza_gsi_arm64
PRODUCT_DEVICE := generic_arm64
PRODUCT_MODEL := elizaOS GSI (ARM64)

# Set before inheriting eliza_common.mk so the brand property can pin
# this image to its lunch target.
ELIZA_PRODUCT_TAG := eliza_gsi_arm64

# Set before inheriting eliza_common.mk: a GSI has no separate product image,
# so the shared layer allows the system-partition launcher and its grants in
# the GSI artifact path requirement.
ELIZA_GSI := true

$(call inherit-product, vendor/eliza/eliza_common.mk)
