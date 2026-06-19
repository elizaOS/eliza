$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)

PRODUCT_NAME := eliza_cf_riscv64_phone
PRODUCT_DEVICE := vsoc_riscv64
PRODUCT_MODEL := elizaOS Cuttlefish Phone (RISC-V 64)

# Set before inheriting eliza_common.mk so the brand property can pin
# this image to its lunch target.
ELIZA_PRODUCT_TAG := eliza_cf_riscv64_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
$(call inherit-product, device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk)
