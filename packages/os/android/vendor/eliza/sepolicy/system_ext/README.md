# System_ext SELinux policy

Included by `SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS` for Android 17 GSI products.
A GSI uses the device vendor partition, so its policy must ship in system_ext.
App-data execution rules apply only to development images. Validate changes
through the full [AOSP build](../../../../README.md).
