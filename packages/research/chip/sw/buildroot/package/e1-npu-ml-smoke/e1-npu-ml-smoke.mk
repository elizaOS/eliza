################################################################################
#
# e1-npu-ml-smoke
#
################################################################################

E1_NPU_ML_SMOKE_VERSION = 1.0
E1_NPU_ML_SMOKE_SITE = $(BR2_EXTERNAL_ELIZA_E1_PATH)/package/e1-npu-ml-smoke/src
E1_NPU_ML_SMOKE_SITE_METHOD = local
E1_NPU_ML_SMOKE_LICENSE = GPL-2.0-only
E1_NPU_ML_SMOKE_LICENSE_FILES = LICENSE

define E1_NPU_ML_SMOKE_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) -Wall -Wextra -O2 \
		-I$(BR2_EXTERNAL_ELIZA_E1_PATH)/../linux/drivers/e1 \
		-o $(@D)/e1-npu-ml-smoke $(@D)/e1-npu-ml-smoke.c
endef

define E1_NPU_ML_SMOKE_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/e1-npu-ml-smoke \
		$(TARGET_DIR)/usr/bin/e1-npu-ml-smoke
endef

$(eval $(generic-package))
