# Shared elizaOS product layer.
#
# Per-target product makefiles (Cuttlefish, Pixel codenames) inherit from
# the matching device makefile first, then `inherit-product` this file.
# Anything that should hold for *every* elizaOS image lands here.
#
# Invariants:
#   1. The Eliza APK is installed as a privileged system app.
#   2. The privapp / default-permissions XMLs ship under /system/etc/.
#   3. Every stock app whose role we override is removed from
#      PRODUCT_PACKAGES so the resolver has a single answer for HOME,
#      DIALER, SMS, ASSISTANT, contacts, browser, calendar, camera,
#      gallery, music, deskclock, search.
#   4. First-boot setup wizard / provisioning is disabled — the device
#      must boot directly to Eliza, not to a Google "Welcome" flow.
#   5. Brand properties land on /product/ where the product layer owns
#      them, not on /system.
#   6. The assistant/full-control capability manifest is baked into
#      /product/etc/eliza/ for static image validation and field debug.

PRODUCT_BRAND := Eliza
PRODUCT_MANUFACTURER := Eliza

PRODUCT_PACKAGES += \
    Eliza \
    ElizaSystemBridge \
    eliza_pvm_mgr \
    default-permissions-ai.elizaos.app.xml \
    privapp-permissions-ai.elizaos.app.xml \
    privapp-permissions-ai.elizaos.system.bridge.xml

# Strip every stock app whose role Eliza owns. Trebuchet is LineageOS's
# launcher; absent from AOSP but harmless to list. SetupWizard ships with
# Pixel partner blobs only; stripping it here has no effect on Cuttlefish
# and load-bearing on Pixel targets.
PRODUCT_PACKAGES -= \
    Browser2 \
    Calendar \
    Camera2 \
    Contacts \
    DeskClock \
    Dialer \
    Email \
    Gallery2 \
    Launcher3 \
    Launcher3QuickStep \
    ManagedProvisioning \
    Messaging \
    messaging \
    Music \
    Provision \
    QuickSearchBox \
    SetupWizard \
    Trebuchet

PRODUCT_PACKAGE_OVERLAYS += \
    vendor/eliza/overlays

PRODUCT_ARTIFACT_PATH_REQUIREMENT_ALLOWED_LIST += \
    system/priv-app/Eliza/% \
    system/priv-app/ElizaSystemBridge/% \
    system/bin/eliza_pvm_mgr \
    system/etc/default-permissions/default-permissions-ai.elizaos.app.xml \
    system/etc/permissions/privapp-permissions-ai.elizaos.app.xml \
    system/etc/permissions/privapp-permissions-ai.elizaos.system.bridge.xml \
    product/etc/eliza/aosp-assistant-full-control.json \
    product/etc/eliza/tee-policy.json \
    product/etc/eliza/tee-measurements.json \
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
    vendor/eliza/init/init.eliza.rc:$(TARGET_COPY_OUT_PRODUCT)/etc/init/init.eliza.rc \
    vendor/eliza/manifests/aosp-assistant-full-control.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/aosp-assistant-full-control.json

# TEE protected-agent profile (plan §5 / measured-boot contract "AOSP Path").
# The signed golden TEE policy + release measurements ship at
# /product/etc/eliza/ in the same schema as the Linux path. On the bring-up
# track these are draft measurements with confidentialityBlocked=true; a real
# release replaces tee-measurements.json with generate-tee-measurements.mjs
# output. eliza_pvm_mgr (vendor/eliza/sepolicy/eliza_pvm_mgr.te) reads them.
PRODUCT_COPY_FILES += \
    vendor/eliza/tee/tee-policy.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/tee-policy.json \
    vendor/eliza/tee/tee-measurements.json:$(TARGET_COPY_OUT_PRODUCT)/etc/eliza/tee-measurements.json

# Boot animation. Override with a brand-specific zip; falls through to
# AOSP defaults if the zip is absent (the file is gitignored locally
# but populated by `scripts/elizaos/build-bootanimation.mjs`).
ifneq ($(wildcard vendor/eliza/bootanimation/bootanimation.zip),)
PRODUCT_COPY_FILES += \
    vendor/eliza/bootanimation/bootanimation.zip:$(TARGET_COPY_OUT_PRODUCT)/media/bootanimation.zip
endif

# Sepolicy hooks. Custom domains for the Eliza priv-app go under
# vendor/eliza/sepolicy/private; public types under .../public.
# Empty today — denials show up in logcat tagged `avc: denied` until
# real policy is written. BOARD_VENDOR_SEPOLICY_DIRS is the historical
# variable; SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS is the modular-equivalent.
BOARD_VENDOR_SEPOLICY_DIRS += vendor/eliza/sepolicy
