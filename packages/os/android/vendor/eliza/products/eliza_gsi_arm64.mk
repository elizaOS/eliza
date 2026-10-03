# Generic System Image for arm64 Treble devices, pinned by the
# gsi-android15, gsi-android16 and gsi-android17 profiles in
# android/aosp.lock.json. The tablet maker supplies the vendor, boot and ODM
# partitions; this product owns only system, system_ext and product.
#
# AOSP release tags ship no gsi_arm64.mk (that lunch target exists only on
# Google's android*-gsi branches). At android-15.0.0_r36, android-16.0.0_r4 and
# android-17.0.0_r1 the AOSP GSI product is aosp_arm64.mk, and it applies
# gsi_release.mk only when TARGET_PRODUCT is exactly aosp_arm64, so a derived
# product inherits the release layer itself.
$(call inherit-product, $(SRC_TARGET_DIR)/product/aosp_arm64.mk)
$(call inherit-product, $(SRC_TARGET_DIR)/product/gsi_release.mk)

MODULE_BUILD_FROM_SOURCE ?= true

PRODUCT_NAME := eliza_gsi_arm64
PRODUCT_DEVICE := generic_arm64
PRODUCT_MODEL := elizaOS GSI (ARM64)

# Set before inheriting eliza_common.mk so the brand property can pin
# this image to its lunch target.
ELIZA_PRODUCT_TAG := eliza_gsi_arm64

# Set before inheriting eliza_common.mk: a GSI cannot ship vendor policy, so
# the shared layer scopes SELinux policy to system_ext instead.
ELIZA_GSI := true

$(call inherit-product, vendor/eliza/eliza_common.mk)
