// SPDX-License-Identifier: GPL-2.0-only
/*
 * Eliza e1 GPIO: minimal gpio-mmio driver.
 *
 * Wraps the single GPIO_OUT 32-bit register inside the peripheral-control
 * window (E1_PERIPH_GPIO_OUT_OFFSET) as a 32-line output-only gpiochip
 * via bgpio_init().
 */

#include <linux/gpio/driver.h>
#include <linux/io.h>
#include <linux/module.h>
#include <linux/of.h>
#include <linux/platform_device.h>

#include "e1_platform_contract.h"

#define E1_GPIO_NGPIO 32

struct eliza_e1_gpio {
	struct gpio_chip gc;
	void __iomem *regs;
};

static int eliza_e1_gpio_probe(struct platform_device *pdev)
{
	struct eliza_e1_gpio *g;
	struct resource *res;
	void __iomem *gpio_out;
	int ret;

	g = devm_kzalloc(&pdev->dev, sizeof(*g), GFP_KERNEL);
	if (!g)
		return -ENOMEM;

	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	g->regs = devm_ioremap_resource(&pdev->dev, res);
	if (IS_ERR(g->regs))
		return PTR_ERR(g->regs);

	gpio_out = g->regs + E1_PERIPH_GPIO_OUT_OFFSET;

	ret = bgpio_init(&g->gc, &pdev->dev, 4,
			 gpio_out, gpio_out, NULL, NULL, NULL,
			 BGPIOF_READ_OUTPUT_REG_SET);
	if (ret)
		return ret;

	g->gc.label = dev_name(&pdev->dev);
	g->gc.parent = &pdev->dev;
	g->gc.owner = THIS_MODULE;
	g->gc.ngpio = E1_GPIO_NGPIO;
	g->gc.base = -1;
	g->gc.of_node = pdev->dev.of_node;

	platform_set_drvdata(pdev, g);
	return devm_gpiochip_add_data(&pdev->dev, &g->gc, g);
}

static const struct of_device_id eliza_e1_gpio_of_match[] = {
	{ .compatible = "eliza,e1-gpio" },
	{ }
};
MODULE_DEVICE_TABLE(of, eliza_e1_gpio_of_match);

static struct platform_driver eliza_e1_gpio_driver = {
	.probe = eliza_e1_gpio_probe,
	.driver = {
		.name = "eliza-e1-gpio",
		.of_match_table = eliza_e1_gpio_of_match,
	},
};
module_platform_driver(eliza_e1_gpio_driver);

MODULE_DESCRIPTION("Eliza e1 GPIO (gpio-mmio backed)");
MODULE_AUTHOR("Eliza e1 BSP");
MODULE_LICENSE("GPL");
