# Shared elizaOS product layer.
#
# Per-target product makefiles (Cuttlefish, Pixel codenames) inherit from
# the matching device makefile first, then `inherit-product` this file.
# Anything that should hold for *every* elizaOS image lands here.
#
# Invariants:
#   1. The Eliza APK is installed as a privileged system app.
#   2. The privapp / default-permissions XMLs ship under /system/etc/.
#   3. Role defaults select Eliza; inherited stock packages are not removed
#      by this product layer.
#   4. First-boot setup wizard / provisioning is disabled — the device
#      must boot directly to Eliza, not to a Google "Welcome" flow.
#   5. Brand properties land on /product/ where the product layer owns
#      them, not on /system.
#   6. The assistant/full-control capability manifest is baked into
#      /product/etc/eliza/ for static image validation and field debug.

PRODUCT_BRAND := elizaOS
PRODUCT_MANUFACTURER := elizaOS

PRODUCT_PACKAGES += \
    Eliza \
    ElizaChromiumBrowser \
    ElizaBitwarden \
    default-permissions-ai.elizaos.app.xml \
    privapp-permissions-ai.elizaos.app.xml

# Role/HOME defaults in vendor/eliza/overlays keep Eliza in front. Removing
# inherited stock packages needs a supported mechanism and boot verification:
# inherit-product aggregation is deferred past this file's evaluation. Do not
# use `PRODUCT_PACKAGES -=`: it is not a make operator and GNU Make 4 rejects it.

PRODUCT_PACKAGE_OVERLAYS += \
    vendor/eliza/overlays

PRODUCT_ARTIFACT_PATH_REQUIREMENT_ALLOWED_LIST += \
    system/priv-app/Eliza/% \
    system/etc/default-permissions/default-permissions-ai.elizaos.app.xml \
    system/etc/permissions/privapp-permissions-ai.elizaos.app.xml \
    product/app/ElizaChromiumBrowser/% \
    product/app/ElizaBitwarden/% \
    product/etc/eliza/browser-apps.json \
    product/etc/eliza/aosp-assistant-full-control.json \
    product/etc/init/init.eliza.rc \
    product/media/bootanimation.zip

PRODUCT_PRODUCT_PROPERTIES += \
    ro.elizaos.product=$(ELIZA_PRODUCT_TAG) \
    ro.elizaos.home=ai.elizaos.app \
    ro.setupwizard.mode=DISABLED \
    persist.sys.fflag.override.settings_provider_model=false

# Boot-time init: starts services, sets elizaOS-specific properties,
# and runs once-per-boot grants for appops the privapp manifest can't
# express (SYSTEM_ALERT_WINDOW, GET_USAGE_STATS user-visible default).
PRODUCT_COPY_FILES += \
    vendor/eliza/manifests/browser-apps.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/browser-apps.json \
    vendor/eliza/init/init.eliza.rc:$(TARGET_COPY_OUT_PRODUCT)/etc/init/init.eliza.rc \
    vendor/eliza/manifests/aosp-assistant-full-control.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/aosp-assistant-full-control.json

# Boot animation. Override with a brand-specific zip; falls through to
# AOSP defaults if the zip is absent (the file is gitignored locally
# but populated by `scripts/elizaos/build-bootanimation.ts`).
ifneq ($(wildcard vendor/eliza/bootanimation/bootanimation.zip),)
PRODUCT_COPY_FILES += \
    vendor/eliza/bootanimation/bootanimation.zip:$(TARGET_COPY_OUT_PRODUCT)/media/bootanimation.zip
endif

# Keep the declaration next to the product overlay so Cuttlefish and generated
# Pixel products share the same intended policy contract. Whether this
# product-level append is consumed by a given Android 17 board is build-system
# dependent; the compiled CIL and on-device denials are authoritative and are
# required in the hardware gate.
#
# GSI products (ELIZA_GSI := true) run on a third-party vendor partition, so
# vendor policy would never ship with the image. They scope policy to
# system_ext instead. Soong globs each policy directory non-recursively, so
# the subdirectories below are only compiled where they are listed.
#
ifneq ($(PLATFORM_SDK_VERSION),37)
$(error vendor/eliza: Android 17 SDK 37 is required)
endif
ifeq ($(ELIZA_GSI),true)
SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS += vendor/eliza/sepolicy/system_ext vendor/eliza/sepolicy/common
else
BOARD_VENDOR_SEPOLICY_DIRS += vendor/eliza/sepolicy vendor/eliza/sepolicy/common
endif
