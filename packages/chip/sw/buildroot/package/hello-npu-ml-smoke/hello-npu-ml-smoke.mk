HELLO_NPU_ML_SMOKE_SITE = $(BR2_EXTERNAL_ELIZA_E1_PATH)/package/hello-npu-ml-smoke/src
HELLO_NPU_ML_SMOKE_SITE_METHOD = local

define HELLO_NPU_ML_SMOKE_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) -I$(@D) -o $(@D)/hello-npu-ml-smoke $(@D)/hello-npu-ml-smoke.c
endef

define HELLO_NPU_ML_SMOKE_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/hello-npu-ml-smoke $(TARGET_DIR)/usr/bin/hello-npu-ml-smoke
endef

$(eval $(generic-package))
