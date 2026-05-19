// SPDX-License-Identifier: GPL-2.0-only
#include <linux/fs.h>
#include <linux/io.h>
#include <linux/ioctl.h>
#include <linux/miscdevice.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/of.h>
#include <linux/platform_device.h>
#include <linux/uaccess.h>

#include "hello-npu-uapi.h"
#include "hello_platform_contract.h"

struct hello_npu {
	void __iomem *regs;
	struct miscdevice miscdev;
	struct mutex lock;
};

static int hello_npu_wait_done(struct hello_npu *npu, u32 *status)
{
	u32 poll;
	u32 value = 0;

	for (poll = 0; poll < HELLO_NPU_DEFAULT_POLL_LIMIT; poll++) {
		value = readl(npu->regs + HELLO_NPU_CTRL_STATUS_OFFSET);
		if (value & HELLO_NPU_CTRL_ERROR) {
			*status = value;
			return -EIO;
		}
		if (value & HELLO_NPU_CTRL_DONE) {
			*status = value;
			return 0;
		}
		cpu_relax();
	}
	*status = value;
	return -ETIMEDOUT;
}

static void hello_npu_fill_counters(struct hello_npu *npu, struct hello_npu_counters *c)
{
	c->ctrl_status = readl(npu->regs + HELLO_NPU_CTRL_STATUS_OFFSET);
	c->desc_status = readl(npu->regs + HELLO_NPU_DESC_STATUS_OFFSET);
	c->desc_head = readl(npu->regs + HELLO_NPU_DESC_HEAD_OFFSET);
	c->desc_tail = readl(npu->regs + HELLO_NPU_DESC_TAIL_OFFSET);
	c->desc_timeout_count = readl(npu->regs + HELLO_NPU_DESC_TIMEOUT_COUNT_OFFSET);
	c->desc_bytes_read = readl(npu->regs + HELLO_NPU_DESC_BYTES_READ_OFFSET);
	c->perf_cycles = readl(npu->regs + HELLO_NPU_PERF_CYCLES_OFFSET);
	c->perf_macs = readl(npu->regs + HELLO_NPU_PERF_MACS_OFFSET);
	c->perf_ops = readl(npu->regs + HELLO_NPU_PERF_OPS_OFFSET);
	c->perf_errors = readl(npu->regs + HELLO_NPU_PERF_ERRORS_OFFSET);
	c->perf_unsupported_ops = readl(npu->regs + HELLO_NPU_PERF_UNSUPPORTED_OPS_OFFSET);
}

static void hello_npu_write_scratch_bytes(struct hello_npu *npu, u32 offset, const u8 *data, u32 len)
{
	u32 first_word = offset / 4;
	u32 last_word = (offset + len - 1) / 4;
	u32 word;
	u32 byte;

	for (word = first_word; word <= last_word; word++) {
		u32 value = readl(npu->regs + HELLO_NPU_SCRATCH0_OFFSET + word * 4);

		for (byte = 0; byte < 4; byte++) {
			u32 scratch_index = word * 4 + byte;

			if (scratch_index >= offset && scratch_index < offset + len) {
				u32 data_index = scratch_index - offset;

				value &= ~(0xffu << (byte * 8));
				value |= ((u32)data[data_index]) << (byte * 8);
			}
		}
		writel(value, npu->regs + HELLO_NPU_SCRATCH0_OFFSET + word * 4);
	}
}

static long hello_npu_run_gemm_s8(struct hello_npu *npu, unsigned long arg)
{
	struct hello_npu_gemm_s8 gemm;
	u32 a_bytes;
	u32 b_bytes;
	u32 c_base;
	u32 c_bytes;
	u32 status;
	u32 i;
	int ret;

	if (copy_from_user(&gemm, (void __user *)arg, sizeof(gemm)))
		return -EFAULT;
	if (gemm.m < 1 || gemm.m > 3 || gemm.n < 1 || gemm.n > 3 || gemm.k < 1 || gemm.k > 7)
		return -EINVAL;
	a_bytes = gemm.m * gemm.k;
	b_bytes = gemm.k * gemm.n;
	c_base = (a_bytes + b_bytes + 3) & ~3u;
	c_bytes = gemm.m * gemm.n * sizeof(__s32);
	if (c_base + c_bytes > HELLO_NPU_SCRATCH_BYTES)
		return -EINVAL;

	mutex_lock(&npu->lock);
	writel(HELLO_NPU_CTRL_DONE | HELLO_NPU_CTRL_ERROR, npu->regs + HELLO_NPU_CTRL_STATUS_OFFSET);
	for (i = 0; i < HELLO_NPU_SCRATCH_BYTES; i += 4)
		writel(0, npu->regs + HELLO_NPU_SCRATCH0_OFFSET + i);
	hello_npu_write_scratch_bytes(npu, 0, (const u8 *)gemm.a, a_bytes);
	hello_npu_write_scratch_bytes(npu, a_bytes, (const u8 *)gemm.b, b_bytes);
	writel(gemm.m | (gemm.n << 8) | (gemm.k << 16), npu->regs + HELLO_NPU_GEMM_CFG_OFFSET);
	writel((a_bytes << 8) | (c_base << 16), npu->regs + HELLO_NPU_GEMM_BASE_OFFSET);
	writel(gemm.k | (gemm.n << 8) | ((gemm.n * 4) << 16), npu->regs + HELLO_NPU_GEMM_STRIDE_OFFSET);
	writel(HELLO_NPU_OP_GEMM_S8, npu->regs + HELLO_NPU_OPCODE_OFFSET);
	writel(HELLO_NPU_CTRL_DONE, npu->regs + HELLO_NPU_CTRL_STATUS_OFFSET);
	writel(HELLO_NPU_CTRL_START, npu->regs + HELLO_NPU_CTRL_STATUS_OFFSET);
	ret = hello_npu_wait_done(npu, &status);
	gemm.status = status;
	for (i = 0; i < gemm.m * gemm.n; i++)
		gemm.c[i] = readl(npu->regs + HELLO_NPU_SCRATCH0_OFFSET + c_base + i * 4);
	mutex_unlock(&npu->lock);
	if (copy_to_user((void __user *)arg, &gemm, sizeof(gemm)))
		return -EFAULT;
	return ret;
}

static long hello_npu_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
	struct hello_npu *npu = container_of(file->private_data, struct hello_npu, miscdev);
	struct hello_npu_counters counters;

	switch (cmd) {
	case HELLO_NPU_IOC_GET_CONTRACT: {
		struct hello_npu_contract contract = {
			.version = HELLO_CONTRACT_VERSION,
			.npu_base = HELLO_NPU_BASE,
			.window_bytes = HELLO_IMPLEMENTED_WINDOW_BYTES,
			.scratch_bytes = HELLO_NPU_SCRATCH_BYTES,
		};

		if (copy_to_user((void __user *)arg, &contract, sizeof(contract)))
			return -EFAULT;
		return 0;
	}
	case HELLO_NPU_IOC_RUN_GEMM_S8:
		return hello_npu_run_gemm_s8(npu, arg);
	case HELLO_NPU_IOC_GET_COUNTERS:
		hello_npu_fill_counters(npu, &counters);
		if (copy_to_user((void __user *)arg, &counters, sizeof(counters)))
			return -EFAULT;
		return 0;
	default:
		return -ENOTTY;
	}
}

static const struct file_operations hello_npu_fops = {
	.owner = THIS_MODULE,
	.unlocked_ioctl = hello_npu_ioctl,
	.compat_ioctl = hello_npu_ioctl,
	.llseek = no_llseek,
};

static int hello_npu_probe(struct platform_device *pdev)
{
	struct hello_npu *npu;
	struct resource *res;

	npu = devm_kzalloc(&pdev->dev, sizeof(*npu), GFP_KERNEL);
	if (!npu)
		return -ENOMEM;
	res = platform_get_resource(pdev, IORESOURCE_MEM, 0);
	npu->regs = devm_ioremap_resource(&pdev->dev, res);
	if (IS_ERR(npu->regs))
		return PTR_ERR(npu->regs);
	mutex_init(&npu->lock);
	npu->miscdev.minor = MISC_DYNAMIC_MINOR;
	npu->miscdev.name = "hello-npu";
	npu->miscdev.fops = &hello_npu_fops;
	npu->miscdev.parent = &pdev->dev;
	platform_set_drvdata(pdev, npu);
	return misc_register(&npu->miscdev);
}

static int hello_npu_remove(struct platform_device *pdev)
{
	struct hello_npu *npu = platform_get_drvdata(pdev);

	misc_deregister(&npu->miscdev);
	return 0;
}

static const struct of_device_id hello_npu_of_match[] = {
	{ .compatible = "openphone,hello-npu" },
	{ }
};
MODULE_DEVICE_TABLE(of, hello_npu_of_match);

static struct platform_driver hello_npu_driver = {
	.probe = hello_npu_probe,
	.remove = hello_npu_remove,
	.driver = {
		.name = "hello-npu",
		.of_match_table = hello_npu_of_match,
	},
};
module_platform_driver(hello_npu_driver);

MODULE_DESCRIPTION("hello NPU minimum target driver");
MODULE_LICENSE("GPL");
