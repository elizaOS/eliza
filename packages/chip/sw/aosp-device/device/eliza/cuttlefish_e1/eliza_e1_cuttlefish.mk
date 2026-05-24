# Eliza e1 NPU sim overlay for Cuttlefish aosp_cf_riscv64_phone-* builds.
#
# Layered onto the Cuttlefish phone product via:
#   PRODUCT_PACKAGE_OVERLAYS or
#   $(call inherit-product, device/eliza/cuttlefish_e1/eliza_e1_cuttlefish.mk)
#
# Task 28's build script (sw/aosp-device/build-aosp-riscv64.sh) is the
# operator entry point. The script copies device/eliza into the AOSP
# workspace and inherits this fragment into the Cuttlefish phone product.

# Pull in the simulator HAL service binary, init rc, and VINTF fragment.
# This is the only added package — the rest of the Cuttlefish HAL stack
# remains untouched.
PRODUCT_PACKAGES += \
    vendor.eliza.e1_npu@1.0-service.sim

# The sim service flips vendor.e1_npu.ready=1 itself on early-boot, so
# the default vendor property used by the on-silicon target is preserved
# at 0 here. The sim's init.rc owns the activation transition.
PRODUCT_VENDOR_PROPERTIES += \
    ro.hardware.e1_npu.backend=simulator \
    vendor.e1_npu.simulator=1

# Vendor sepolicy: reuse the eliza_ai_soc fragment so hal_e1_npu_default
# (used by both the real and sim service binaries) is defined exactly
# once. file_contexts for the .sim binary lives in this overlay.
BOARD_VENDOR_SEPOLICY_DIRS += device/eliza/eliza_ai_soc/sepolicy
BOARD_VENDOR_SEPOLICY_DIRS += device/eliza/cuttlefish_e1/sepolicy

# The shared eliza_e1.xml is the single VINTF declaration for
# vendor.eliza.e1_npu. Do not add another Cuttlefish DEVICE_MANIFEST_FILE here:
# libvintf rejects duplicate @1.0::IE1Npu/default entries before the virtual
# device can boot.
