# Android 17+ vendor SELinux policy

Selected by `eliza_common.mk` when `PLATFORM_SDK_VERSION` is 37 or later. Android 17
assigns platform-signed apps that target SDK 36 or lower to `platform_app_36`; that type
does not exist on Android 15 or 16, so these rules are kept out of the shared directory.
Validate changes through the full [AOSP build](../../../../README.md).
