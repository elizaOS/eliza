# SPDX-License-Identifier: GPL-2.0-only
#
# Eliza e1 BSP drivers. Import into an external Linux tree at
# drivers/misc/eliza-e1/ and add `obj-$(CONFIG_ELIZA_E1_BSP) += eliza-e1/`
# from drivers/misc/Makefile.

obj-$(CONFIG_ELIZA_E1_NPU)     += eliza-e1-npu.o
obj-$(CONFIG_ELIZA_E1_DMA)     += eliza-e1-dma.o
obj-$(CONFIG_ELIZA_E1_DISPLAY) += eliza-e1-display.o
obj-$(CONFIG_ELIZA_E1_GPIO)    += eliza-e1-gpio.o

ccflags-y += -I$(src)
