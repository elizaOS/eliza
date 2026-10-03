# Vendor SELinux policy

Included by `BOARD_VENDOR_SEPOLICY_DIRS` in `eliza_common.mk`. Rules here must compile on
Android 15, 16 and 17; Android 17-only `platform_app_36` rules are in [api37](api37/). Validate changes
through the full [AOSP build](../../../README.md); installer frontend tests do not
compile SELinux policy.
