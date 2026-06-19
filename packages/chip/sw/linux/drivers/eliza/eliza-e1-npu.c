// SPDX-License-Identifier: GPL-2.0-only
/*
 * Eliza e1-NPU character driver.
 *
 * /dev/e1-npu supports:
 *   - read():  ASCII "0x%08x\n" of NPU RESULT
 *   - ioctl(): submit OP_A/OP_B/OPCODE, read back result + perf counters
 *   - mmap():  map the 4 KiB MMIO window (root only) for direct register access
 *
 * Offsets come from e1_platform_contract.h. Base address comes from the
 * DT `reg` of the `eliza,e1-npu` node.
 */

#include <linux/fs.h>
#include <linux/io.h>
#include <linux/miscdevice.h>
#include <linux/mm.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/of.h>
#include <linux/of_address.h>
#include <linux/platform_device.h>
#include <linux/uaccess.h>

#include "e1_platform_contract.h"
#include "eliza-e1-npu-uapi.h"

struct eliza_e1_npu {
	struct device *dev;
	void __iomem *regs;
	phys_addr_t phys_base;
	resource_size_t size;
	struct miscdevice miscdev;
	struct mutex lock;
};

static inline struct eliza_e1_npu *miscdev_to_npu(struct file *file)
{
	return container_of(file->private_data, struct eliza_e1_npu,
			    miscdev);
}

static ssize_t eliza_e1_npu_read(struct file *file, char __user *buf,
					size_t len, loff_t *ppos)
{
	struct eliza_e1_npu *npu = miscdev_to_npu(file);
	char tmp[16];
	u32 value;
	int n;

	value = readl(npu->regs + E1_NPU_RESULT_OFFSET);
	n = scnprintf(tmp, sizeof(tmp), "0x%08x\n", value);
	return simple_read_from_buffer(buf, len, ppos, tmp, n);
}

static long eliza_e1_npu_submit(struct eliza_e1_npu *npu,
				       void __user *argp)
{
	struct eliza_e1_npu_job job;

	if (copy_from_user(&job, argp, sizeof(job)))
		return -EFAULT;

	mutex_lock(&npu->lock);
	writel(job.op_a, npu->regs + E1_NPU_OP_A_OFFSET);
	writel(job.op_b, npu->regs + E1_NPU_OP_B_OFFSET);
	writel(job.opcode, npu->regs + E1_NPU_OPCODE_OFFSET);
	writel(0x1u, npu->regs + E1_NPU_CTRL_STATUS_OFFSET);

	job.result = readl(npu->regs + E1_NPU_RESULT_OFFSET);
	job.result_hi = readl(npu->regs + E1_NPU_RESULT_HI_OFFSET);
	job.ctrl_status = readl(npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
	job.perf_cycles = readl(npu->regs + E1_NPU_PERF_CYCLES_OFFSET);
	job.perf_macs = readl(npu->regs + E1_NPU_PERF_MACS_OFFSET);
	job.perf_errors = readl(npu->regs + E1_NPU_PERF_ERRORS_OFFSET);
	mutex_unlock(&npu->lock);

	if (copy_to_user(argp, &job, sizeof(job)))
		return -EFAULT;
	return 0;
}

static long eliza_e1_npu_ioctl(struct file *file, unsigned int cmd,
				      unsigned long arg)
{
	struct eliza_e1_npu *npu = miscdev_to_npu(file);
	void __user *argp = (void __user *)arg;

	switch (cmd) {
	case ELIZA_E1_NPU_IOC_SUBMIT:
		return eliza_e1_npu_submit(npu, argp);
	case ELIZA_E1_NPU_IOC_GET_CONTRACT: {
		struct eliza_e1_npu_contract c = {
			.version = E1_CONTRACT_VERSION,
			.npu_base = E1_NPU_BASE,
			.window_bytes = E1_IMPLEMENTED_WINDOW_BYTES,
			.unmapped_read_value = E1_UNMAPPED_READ_VALUE,
		};
		return copy_to_user(argp, &c, sizeof(c)) ? -EFAULT : 0;
	}
	default:
		return -ENOTTY;
	}
}

static int eliza_e1_npu_mmap(struct file *file,
				    struct vm_area_struct *vma)
{
	struct eliza_e1_npu *npu = miscdev_to_npu(file);
	unsigned long size = vma->vm_end - vma->vm_start;

	if (!capable(CAP_SYS_RAWIO))
		return -EPERM;
	if (vma->vm_pgoff != 0)
		return -EINVAL;
	if (size > npu->size)
		return -EINVAL;

	vma->vm_page_prot = pgprot_noncached(vma->vm_page_prot);
	return io_remap_pfn_range(vma, vma->vm_start,
				  npu->phys_base >> PAGE_SHIFT,
				  size, vma->vm_page_prot);
}

static const struct file_operations eliza_e1_npu_fops = {
	.owner = THIS_MODULE,
	.read = eliza_e1_npu_read,
	.unlocked_ioctl = eliza_e1_npu_ioctl,
	.compat_ioctl = eliza_e1_npu_ioctl,
	.mmap = eliza_e1_npu_mmap,
};

static int eliza_e1_npu_probe(struct platform_device *pdev)
{
	struct eliza_e1_npu *npu;
	struct resource *res;

	npu = devm_kzalloc(&pdev->dev, sizeof(*npu), GFP_KERNEL);
	if (!npu)
		return -ENOMEM;

	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	if (!res)
		return -EINVAL;

	npu->dev = &pdev->dev;
	npu->phys_base = res->start;
	npu->size = resource_size(res);
	npu->regs = devm_ioremap_resource(&pdev->dev, res);
	if (IS_ERR(npu->regs))
		return PTR_ERR(npu->regs);

	mutex_init(&npu->lock);

	npu->miscdev.minor = MISC_DYNAMIC_MINOR;
	npu->miscdev.name = "e1-npu";
	npu->miscdev.fops = &eliza_e1_npu_fops;
	npu->miscdev.parent = &pdev->dev;
	platform_set_drvdata(pdev, npu);

	dev_info(&pdev->dev,
		 "eliza-e1-npu: phys=0x%llx size=0x%llx contract_v%u\n",
		 (u64)npu->phys_base, (u64)npu->size,
		 E1_CONTRACT_VERSION);

	return misc_register(&npu->miscdev);
}

static void eliza_e1_npu_remove(struct platform_device *pdev)
{
	struct eliza_e1_npu *npu = platform_get_drvdata(pdev);

	misc_deregister(&npu->miscdev);
}

static const struct of_device_id eliza_e1_npu_of_match[] = {
	{ .compatible = "eliza,e1-npu" },
	{ }
};
MODULE_DEVICE_TABLE(of, eliza_e1_npu_of_match);

static struct platform_driver eliza_e1_npu_driver = {
	.probe = eliza_e1_npu_probe,
	.remove = eliza_e1_npu_remove,
	.driver = {
		.name = "eliza-e1-npu",
		.of_match_table = eliza_e1_npu_of_match,
	},
};
module_platform_driver(eliza_e1_npu_driver);

MODULE_DESCRIPTION("Eliza e1 NPU character driver");
MODULE_AUTHOR("Eliza e1 BSP");
MODULE_LICENSE("GPL");
