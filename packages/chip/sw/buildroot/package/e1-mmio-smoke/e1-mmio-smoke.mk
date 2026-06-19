################################################################################
#
# e1-mmio-smoke
#
################################################################################

E1_MMIO_SMOKE_VERSION = 1.0
E1_MMIO_SMOKE_SITE = $(BR2_EXTERNAL_ELIZA_E1_PATH)/package/e1-mmio-smoke/src
E1_MMIO_SMOKE_SITE_METHOD = local
E1_MMIO_SMOKE_LICENSE = GPL-2.0-only
E1_MMIO_SMOKE_LICENSE_FILES = LICENSE

define E1_MMIO_SMOKE_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) -Wall -O2 \
		-o $(@D)/e1-mmio-smoke $(@D)/e1-mmio-smoke.c
endef

define E1_MMIO_SMOKE_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/e1-mmio-smoke \
		$(TARGET_DIR)/usr/bin/e1-mmio-smoke
endef

$(eval $(generic-package))
