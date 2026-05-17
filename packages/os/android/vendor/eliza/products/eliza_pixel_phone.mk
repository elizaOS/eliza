# Parameterized Pixel product makefile for ElizaOS.
#
# Per-codename wrappers (eliza_oriole_phone.mk, eliza_panther_phone.mk,
# eliza_shiba_phone.mk, ...) set ELIZA_PIXEL_CODENAME and inherit this
# file. The codename inherit-product line resolves to whichever AOSP
# manifest tag was synced; on `android-latest-release` the Pixel device
# trees only appear during specific release windows, so a `lunch` failure
# pointing at this line means the AOSP checkout doesn't carry the device
# tree for that codename — re-init `repo` against an AOSP tag that does.
#
# References
#   https://developers.google.com/android/drivers — vendor blob downloads
#   https://source.android.com/docs/devices/google-devices

ifndef ELIZA_PIXEL_CODENAME
$(error eliza_pixel_phone.mk requires ELIZA_PIXEL_CODENAME (e.g. oriole, panther, shiba))
endif

$(call inherit-product, device/google/$(ELIZA_PIXEL_CODENAME)/aosp_$(ELIZA_PIXEL_CODENAME).mk)

PRODUCT_NAME := eliza_$(ELIZA_PIXEL_CODENAME)_phone
PRODUCT_DEVICE := $(ELIZA_PIXEL_CODENAME)
PRODUCT_MODEL := ElizaOS Phone ($(ELIZA_PIXEL_CODENAME))

ELIZA_PRODUCT_TAG := eliza_$(ELIZA_PIXEL_CODENAME)_phone

$(call inherit-product, vendor/eliza/eliza_common.mk)
