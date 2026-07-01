// SPDX-License-Identifier: GPL-2.0-only
/*
 * Eliza e1-DMA platform driver.
 *
 * Binds compatible "eliza,e1-dma" and exports sysfs attributes:
 *   contract     - multi-line platform-contract string
 *   bytes_done   - live readback of BYTES_DONE
 *   error_count  - live readback of ERROR_COUNT
 */

#include <linux/io.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/platform_device.h>

#include "e1_platform_contract.h"

struct eliza_e1_dma {
	struct device *dev;
	void __iomem *regs;
};

static ssize_t contract_show(struct device *dev,
			     struct device_attribute *attr, char *buf)
{
	return sysfs_emit(buf,
		"contract_version=%u\n"
		"compatible=eliza,e1-dma\n"
		"E1_DMA_BASE=0x%08x\n"
		"E1_DMA_SRC_OFFSET=0x%02x\n"
		"E1_DMA_DST_OFFSET=0x%02x\n"
		"E1_DMA_LEN_OFFSET=0x%02x\n"
		"E1_DMA_CTRL_STATUS_OFFSET=0x%02x\n"
		"E1_DMA_BYTES_DONE_OFFSET=0x%02x\n"
		"E1_DMA_ERROR_COUNT_OFFSET=0x%02x\n",
		E1_CONTRACT_VERSION,
		E1_DMA_BASE,
		E1_DMA_SRC_OFFSET,
		E1_DMA_DST_OFFSET,
		E1_DMA_LEN_OFFSET,
		E1_DMA_CTRL_STATUS_OFFSET,
		E1_DMA_BYTES_DONE_OFFSET,
		E1_DMA_ERROR_COUNT_OFFSET);
}
static DEVICE_ATTR_RO(contract);

static ssize_t bytes_done_show(struct device *dev,
			       struct device_attribute *attr, char *buf)
{
	struct eliza_e1_dma *dma = dev_get_drvdata(dev);

	return sysfs_emit(buf, "0x%08x\n",
			  readl(dma->regs + E1_DMA_BYTES_DONE_OFFSET));
}
static DEVICE_ATTR_RO(bytes_done);

static ssize_t error_count_show(struct device *dev,
				struct device_attribute *attr, char *buf)
{
	struct eliza_e1_dma *dma = dev_get_drvdata(dev);

	return sysfs_emit(buf, "0x%08x\n",
			  readl(dma->regs + E1_DMA_ERROR_COUNT_OFFSET));
}
static DEVICE_ATTR_RO(error_count);

static struct attribute *eliza_e1_dma_attrs[] = {
	&dev_attr_contract.attr,
	&dev_attr_bytes_done.attr,
	&dev_attr_error_count.attr,
	NULL,
};
ATTRIBUTE_GROUPS(eliza_e1_dma);

static int eliza_e1_dma_probe(struct platform_device *pdev)
{
	struct eliza_e1_dma *dma;
	struct resource *res;
	int ret;

	dma = devm_kzalloc(&pdev->dev, sizeof(*dma), GFP_KERNEL);
	if (!dma)
		return -ENOMEM;

	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	dma->regs = devm_ioremap_resource(&pdev->dev, res);
	if (IS_ERR(dma->regs))
		return PTR_ERR(dma->regs);

	dma->dev = &pdev->dev;
	platform_set_drvdata(pdev, dma);

	ret = sysfs_create_groups(&pdev->dev.kobj, eliza_e1_dma_groups);
	if (ret)
		return ret;

	dev_info(&pdev->dev,
		 "eliza-e1-dma: phys=0x%llx contract_v%u\n",
		 (u64)res->start, E1_CONTRACT_VERSION);
	return 0;
}

static void eliza_e1_dma_remove(struct platform_device *pdev)
{
	sysfs_remove_groups(&pdev->dev.kobj, eliza_e1_dma_groups);
}

static const struct of_device_id eliza_e1_dma_of_match[] = {
	{ .compatible = "eliza,e1-dma" },
	{ }
};
MODULE_DEVICE_TABLE(of, eliza_e1_dma_of_match);

static struct platform_driver eliza_e1_dma_driver = {
	.probe = eliza_e1_dma_probe,
	.remove = eliza_e1_dma_remove,
	.driver = {
		.name = "eliza-e1-dma",
		.of_match_table = eliza_e1_dma_of_match,
	},
};
module_platform_driver(eliza_e1_dma_driver);

MODULE_DESCRIPTION("Eliza e1 DMA contract driver");
MODULE_AUTHOR("Eliza e1 BSP");
MODULE_LICENSE("GPL");
