# Board config scaffold for the Eliza e1 AOSP target.
#
# This belongs in an external AOSP tree at device/eliza/eliza_ai_soc.
# It references the local BSP contract source:
#   sw/platform/e1_platform_contract.json

TARGET_BOARD_PLATFORM := eliza_ai_soc
TARGET_ARCH := riscv64
TARGET_ARCH_VARIANT :=
TARGET_CPU_ABI := riscv64
TARGET_CPU_VARIANT := generic

# Reuse the upstream riscv64 Cuttlefish board contract so the external AOSP
# tree has a real virtual-device kernel, image layout, and launcher metadata.
# The Eliza-specific files below layer the E1 BSP contract on top of that
# simulator base.
-include device/google/cuttlefish/vsoc_riscv64/BoardConfig.mk

# Temporary workaround matching AOSP riscv64 targets while prebuilts lack
# riscv64 variants.
ALLOW_MISSING_DEPENDENCIES := true
TARGET_NO_BOOTLOADER := true
TARGET_NO_KERNEL := false
BOARD_KERNEL_CMDLINE += console=ttyS0 earlycon androidboot.hardware=eliza_ai_soc
BOARD_KERNEL_SEPARATED_DTBO := false
BOARD_VENDOR_SEPOLICY_DIRS += device/eliza/eliza_ai_soc/sepolicy
DEVICE_MANIFEST_FILE += device/eliza/eliza_ai_soc/manifest.xml
DEVICE_MANIFEST_FILE += device/eliza/eliza_ai_soc/eliza_e1.xml
TARGET_COPY_OUT_VENDOR := vendor
BOARD_USES_VENDORIMAGE := true
BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := ext4
BOARD_VENDORIMAGE_PARTITION_SIZE := 268435456
TARGET_USERIMAGES_USE_EXT4 := true

# Scaffold inputs for the external Android kernel/device-tree integration.
# The exact AOSP build variables depend on the selected kernel build flow.
ELIZA_KERNEL_CONFIG_FRAGMENT := device/eliza/eliza_ai_soc/kernel/eliza_ai_soc.fragment
ELIZA_DTS := device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts
