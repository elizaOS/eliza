# The product must provide reviewed resource enrollment and production platform/OTA signing keys.
eliza_system_updater_dir := $(patsubst %/,%,$(dir $(lastword $(MAKEFILE_LIST))))
PRODUCT_PACKAGES += ElizaSystemUpdater privapp-permissions-eliza-system-updater default-permissions-eliza-system-updater
SYSTEM_EXT_PRIVATE_SEPOLICY_DIRS += $(eliza_system_updater_dir)/sepolicy
