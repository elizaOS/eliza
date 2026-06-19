# Start from the upstream riscv64 Cuttlefish phone product so launch_cvd has
# the image set and vendor packages it expects, then layer the Eliza E1 BSP
# contract on top.
$(call inherit-product, device/google/cuttlefish/vsoc_riscv64/phone/aosp_cf.mk)
$(call inherit-product, device/eliza/eliza_ai_soc/device.mk)
$(call inherit-product, vendor/eliza/eliza_common.mk)

PRODUCT_NAME := eliza_ai_soc
PRODUCT_DEVICE := eliza_ai_soc
PRODUCT_BRAND := Eliza
PRODUCT_MODEL := Eliza e1 AI SoC
PRODUCT_MANUFACTURER := Eliza
