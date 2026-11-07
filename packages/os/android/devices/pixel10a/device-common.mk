# Derived from pinned adevtool 17df3b79a73e67ad68387b35c7d41c85e1d8103c.
AB_OTA_POSTINSTALL_CONFIG += \
	RUN_POSTINSTALL_system=true \
	POSTINSTALL_PATH_system=system/bin/otapreopt_script \
	POSTINSTALL_OPTIONAL_system=true

# Set Vendor SPL to match platform
VENDOR_SECURITY_PATCH = $(PLATFORM_SECURITY_PATCH)

# Set boot SPL
BOOT_SECURITY_PATCH = $(PLATFORM_SECURITY_PATCH)

LOCAL_KERNEL := $(TARGET_KERNEL_DIR)/Image.lz4

# Enforce the Product interface
PRODUCT_PRODUCT_VNDK_VERSION := current
PRODUCT_ENFORCE_PRODUCT_PARTITION_INTERFACE := true

TARGET_USES_VULKAN = true

# Init files
PRODUCT_COPY_FILES += \
	$(LOCAL_KERNEL):kernel

# Insmod config files
PRODUCT_COPY_FILES += \
	$(call find-copy-subdir-files,init.insmod.*.cfg,$(TARGET_KERNEL_DIR),$(TARGET_COPY_OUT_VENDOR_DLKM)/etc)

# For creating dtbo image
PRODUCT_HOST_PACKAGES += \
	mkdtimg

# Enable project quotas and casefolding for emulated storage without sdcardfs
$(call inherit-product, $(SRC_TARGET_DIR)/product/emulated_storage.mk)

# Enforce generic ramdisk allow list
$(call inherit-product, $(SRC_TARGET_DIR)/product/generic_ramdisk.mk)

PRODUCT_CHARACTERISTICS := nosdcard

WIFI_PRIV_CMD_UPDATE_MBO_CELL_STATUS := enabled

# Trusty (KM, GK, Storage)
$(call inherit-product, system/core/trusty/trusty-storage.mk)
$(call inherit-product, system/core/trusty/trusty-base.mk)

PRODUCT_USE_DYNAMIC_PARTITIONS := true

SIM_COUNT := 2

# pKVM
$(call inherit-product, packages/modules/Virtualization/apex/product_packages.mk)
PRODUCT_BUILD_PVMFW_IMAGE := true

PRODUCT_COPY_FILES += \
      vendor/adevtool/config/mk/google_devices/common/init.pixel.grapheneos.rc:$(TARGET_COPY_OUT_VENDOR)/etc/init/init.pixel.grapheneos.rc

# telephony_system_ext.mk supplies the AOSP CarrierConfig package.
# Do not route AOSP telephony to the GrapheneOS-only CarrierConfig2 service.

# The Graphene Wi-Fi fault-injection utility requires policy absent from AOSP.

PRODUCT_PACKAGES += restrict-pixel-health-association

PRODUCT_PRODUCT_PROPERTIES += persist.vendor.intelligence=off
