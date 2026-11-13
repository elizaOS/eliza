# Shared elizaOS product layer.
#
# Per-target product makefiles (Cuttlefish, Pixel codenames) inherit from
# the matching device makefile first, then `inherit-product` this file.
# Anything that should hold for *every* elizaOS image lands here.
#
# Invariants (the nonprivileged-launcher profile, shared with the Pixel 10a
# Eliza product):
#   1. The Eliza APK is a presigned, hash- and certificate-pinned,
#      nonprivileged launcher staged by scripts/android/image-launcher.ts into
#      vendor/eliza/launcher/. No privapp allowlist, platform certificate or
#      priv-app placement exists for it.
#   2. Its reviewed first-boot runtime grants (android/products/
#      eliza-images.json) ship as a revocable default-permissions file.
#   3. Provisioning selects Eliza as default HOME, assistant and Autofill
#      offer. Dialer and SMS are not preassigned, and inherited stock packages
#      (launcher, dialer, messaging, Clock, ...) stay installed as recovery
#      paths.
#   4. The first-boot setup wizard is disabled and the setup-complete
#      defaults are seeded, so the device boots to its default HOME (Eliza),
#      not to a Google "Welcome" flow.
#   5. Brand properties land on /product/ where the product layer owns
#      them, not on /system.
#   6. The assistant/full-control capability manifest is baked into
#      /product/etc/eliza/ for static image validation and field debug.

PRODUCT_BRAND := elizaOS
PRODUCT_MANUFACTURER := elizaOS

PRODUCT_PACKAGES += \
    ElizaChromiumBrowser \
    ElizaBitwarden

# The staged launcher adds the Eliza module, its default permissions, the
# provisioning overlay (HOME, assistant, Autofill), the image capability and
# the system Clock. It is generated from the signed APK and refuses a product
# it was not staged for. Do not use `PRODUCT_PACKAGES -=`: it is not a make
# operator and GNU Make 4 rejects it.
ELIZA_LAUNCHER_PRODUCT := vendor/eliza/launcher/product.mk
ifeq ($(wildcard $(ELIZA_LAUNCHER_PRODUCT)),)
$(error vendor/eliza/launcher is not staged: sign the Eliza APK and run packages/os/scripts/android/image-launcher.ts)
endif
$(call inherit-product, $(ELIZA_LAUNCHER_PRODUCT))

PRODUCT_PACKAGE_OVERLAYS += \
    vendor/eliza/overlays

# Artifact path requirements constrain only root/ and system/ (generic_system.mk),
# relative to PRODUCT_OUT. GSI products stage the launcher APK and its grants
# in the system partition (eliza-images.json), so those two paths are allowed
# for a GSI only. Everything else this layer installs goes to
# $(TARGET_COPY_OUT_PRODUCT): product/ on a device build (outside the
# requirement) and system/product/ on a GSI, which gsi_release.mk already
# allows as system/product/%.
ifeq ($(ELIZA_GSI),true)
PRODUCT_ARTIFACT_PATH_REQUIREMENT_ALLOWED_LIST += \
    system/app/Eliza/% \
    system/etc/default-permissions/default-permissions-ai.elizaos.app.xml
endif
PRODUCT_ARTIFACT_PATH_REQUIREMENT_ALLOWED_LIST += \
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

# Boot-time init: elizaOS boot-phase markers only. It grants nothing.
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

# No SELinux policy is added for the Eliza app: as a nonprivileged launcher it
# runs in untrusted_app, which may not execute app data (see sepolicy/README.md).
ifneq ($(PLATFORM_SDK_VERSION),37)
$(error vendor/eliza: Android 17 SDK 37 is required)
endif
