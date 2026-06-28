// SPDX-License-Identifier: GPL-2.0-only
/*
 * Eliza e1 display: simple-framebuffer compatible glue.
 *
 * Programs FB_BASE / MODE / FORMAT / ENABLE from device tree properties and
 * relies on simplefb (compatible "simple-framebuffer") in a sibling DT node
 * to expose /dev/fb0 to userspace. A future DRM/KMS driver can replace this
 * glue without breaking the userspace contract.
 */

#include <linux/io.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/platform_device.h>

#include "e1_platform_contract.h"

#define E1_DISPLAY_ENABLE_BIT 0x1u

struct eliza_e1_display {
	struct device *dev;
	void __iomem *regs;
	u32 mode;
	u32 format;
	u32 fb_base;
};

static ssize_t mode_show(struct device *dev,
			 struct device_attribute *attr, char *buf)
{
	struct eliza_e1_display *d = dev_get_drvdata(dev);

	return sysfs_emit(buf, "mode=0x%08x format=0x%08x fb_base=0x%08x\n",
			  d->mode, d->format, d->fb_base);
}
static DEVICE_ATTR_RO(mode);

static ssize_t vsync_count_show(struct device *dev,
				struct device_attribute *attr, char *buf)
{
	struct eliza_e1_display *d = dev_get_drvdata(dev);

	return sysfs_emit(buf, "0x%08x\n",
			  readl(d->regs + E1_DISPLAY_VSYNC_OFFSET));
}
static DEVICE_ATTR_RO(vsync_count);

static struct attribute *eliza_e1_display_attrs[] = {
	&dev_attr_mode.attr,
	&dev_attr_vsync_count.attr,
	NULL,
};
ATTRIBUTE_GROUPS(eliza_e1_display);

static int eliza_e1_display_probe(struct platform_device *pdev)
{
	struct eliza_e1_display *d;
	struct resource *res;
	int ret;

	d = devm_kzalloc(&pdev->dev, sizeof(*d), GFP_KERNEL);
	if (!d)
		return -ENOMEM;

	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	d->regs = devm_ioremap_resource(&pdev->dev, res);
	if (IS_ERR(d->regs))
		return PTR_ERR(d->regs);

	d->dev = &pdev->dev;
	platform_set_drvdata(pdev, d);

	if (of_property_read_u32(pdev->dev.of_node, "eliza,mode", &d->mode))
		d->mode = 0x01E00280u;
	if (of_property_read_u32(pdev->dev.of_node, "eliza,format",
				 &d->format))
		d->format = 0x34325258u; /* "XR24" little-endian */
	if (of_property_read_u32(pdev->dev.of_node, "eliza,fb-base",
				 &d->fb_base))
		d->fb_base = 0;

	writel(d->fb_base, d->regs + E1_DISPLAY_FB_BASE_OFFSET);
	writel(d->mode, d->regs + E1_DISPLAY_MODE_OFFSET);
	writel(d->format, d->regs + E1_DISPLAY_FORMAT_OFFSET);
	writel(E1_DISPLAY_ENABLE_BIT,
	       d->regs + E1_DISPLAY_ENABLE_OFFSET);

	ret = sysfs_create_groups(&pdev->dev.kobj,
				  eliza_e1_display_groups);
	if (ret)
		return ret;

	dev_info(&pdev->dev,
		 "eliza-e1-display: enabled mode=0x%08x format=0x%08x\n",
		 d->mode, d->format);
	return 0;
}

static void eliza_e1_display_remove(struct platform_device *pdev)
{
	struct eliza_e1_display *d = platform_get_drvdata(pdev);

	writel(0, d->regs + E1_DISPLAY_ENABLE_OFFSET);
	sysfs_remove_groups(&pdev->dev.kobj, eliza_e1_display_groups);
}

static const struct of_device_id eliza_e1_display_of_match[] = {
	{ .compatible = "eliza,e1-display" },
	{ }
};
MODULE_DEVICE_TABLE(of, eliza_e1_display_of_match);

static struct platform_driver eliza_e1_display_driver = {
	.probe = eliza_e1_display_probe,
	.remove = eliza_e1_display_remove,
	.driver = {
		.name = "eliza-e1-display",
		.of_match_table = eliza_e1_display_of_match,
	},
};
module_platform_driver(eliza_e1_display_driver);

MODULE_DESCRIPTION("Eliza e1 display scan-out glue (simple-framebuffer compatible)");
MODULE_AUTHOR("Eliza e1 BSP");
MODULE_LICENSE("GPL");
