// SPDX-License-Identifier: GPL-2.0-only
/*
 * Minimal Eliza e1 DMA Linux driver source.
 *
 * The register layout mirrors sw/platform/e1_platform_contract.json and is
 * intended for an external Linux tree integration.
 */

#include <linux/io.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/platform_device.h>

#include "e1_platform_contract.h"

struct e1_dma {
	void __iomem *regs;
};

static ssize_t contract_show(struct device *dev, struct device_attribute *attr, char *buf)
{
	return sysfs_emit(buf, "E1_DMA_BASE=0x%08x compatible=eliza,e1-dma\n",
			 E1_DMA_BASE);
}
static DEVICE_ATTR_RO(contract);

static int e1_dma_probe(struct platform_device *pdev)
{
	struct e1_dma *dma;
	struct resource *res;

	dma = devm_kzalloc(&pdev->dev, sizeof(*dma), GFP_KERNEL);
	if (!dma)
		return -ENOMEM;

	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	dma->regs = devm_ioremap_resource(&pdev->dev, res);
	if (IS_ERR(dma->regs))
		return PTR_ERR(dma->regs);

	platform_set_drvdata(pdev, dma);
	return device_create_file(&pdev->dev, &dev_attr_contract);
}

static int e1_dma_remove(struct platform_device *pdev)
{
	device_remove_file(&pdev->dev, &dev_attr_contract);
	return 0;
}

static const struct of_device_id e1_dma_of_match[] = {
	{ .compatible = "eliza,e1-dma" },
	{ }
};
MODULE_DEVICE_TABLE(of, e1_dma_of_match);

static struct platform_driver e1_dma_driver = {
	.probe = e1_dma_probe,
	.remove = e1_dma_remove,
	.driver = {
		.name = "eliza-e1-dma",
		.of_match_table = e1_dma_of_match,
	},
};
module_platform_driver(e1_dma_driver);

MODULE_DESCRIPTION("Eliza e1 DMA contract driver");
MODULE_LICENSE("GPL");
