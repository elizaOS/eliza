$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)

PRODUCT_SOONG_DEFINED_SYSTEM_IMAGE := eliza_aosp_shared_system_image

PRODUCT_NAME := eliza_cf_riscv64_e1_phone
PRODUCT_DEVICE := vsoc_riscv64
PRODUCT_MODEL := elizaOS Cuttlefish E1 Phone (RISC-V 64)

# The E1 simulator is a separately provisioned, revision-locked device tree.
# It is intentionally a dedicated product and never changes the canonical
# Cuttlefish launcher products.
ELIZA_PRODUCT_TAG := eliza_cf_riscv64_e1_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
$(call inherit-product, device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk)
