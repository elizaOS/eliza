// SPDX-License-Identifier: GPL-2.0-only
/*
 * Minimal Eliza e1 NPU Linux driver source.
 *
 * Import this file into an external Linux tree before building. The checked-in
 * repository owns the platform contract and BSP source package.
 */

#include <linux/fs.h>
#include <linux/io.h>
#include <linux/ioctl.h>
#include <linux/miscdevice.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/of.h>
#include <linux/of_address.h>
#include <linux/platform_device.h>
#include <linux/uaccess.h>

#include "e1-npu-uapi.h"
#include "e1_platform_contract.h"

struct e1_npu {
	void __iomem *regs;
	struct miscdevice miscdev;
	struct mutex lock;
};

static int e1_npu_wait_done(struct e1_npu *npu, u32 *status)
{
	u32 poll;
	u32 value = 0;

	for (poll = 0; poll < E1_NPU_DEFAULT_POLL_LIMIT; poll++) {
		value = readl(npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
		if (value & E1_NPU_CTRL_ERROR) {
			*status = value;
			return -EIO;
		}
		if (value & E1_NPU_CTRL_DONE) {
			*status = value;
			return 0;
		}
		cpu_relax();
	}

	*status = value;
	return -ETIMEDOUT;
}

static void e1_npu_fill_counters(struct e1_npu *npu, struct e1_npu_counters *c)
{
	c->ctrl_status = readl(npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
	c->desc_status = readl(npu->regs + E1_NPU_DESC_STATUS_OFFSET);
	c->desc_head = readl(npu->regs + E1_NPU_DESC_HEAD_OFFSET);
	c->desc_tail = readl(npu->regs + E1_NPU_DESC_TAIL_OFFSET);
	c->desc_timeout_count = readl(npu->regs + E1_NPU_DESC_TIMEOUT_COUNT_OFFSET);
	c->desc_bytes_read = readl(npu->regs + E1_NPU_DESC_BYTES_READ_OFFSET);
	c->desc_bytes_written = readl(npu->regs + E1_NPU_DESC_BYTES_WRITTEN_OFFSET);
	c->desc_read_beats = readl(npu->regs + E1_NPU_DESC_READ_BEATS_OFFSET);
	c->desc_write_beats = readl(npu->regs + E1_NPU_DESC_WRITE_BEATS_OFFSET);
	c->perf_cycles = readl(npu->regs + E1_NPU_PERF_CYCLES_OFFSET);
	c->perf_macs = readl(npu->regs + E1_NPU_PERF_MACS_OFFSET);
	c->perf_ops = readl(npu->regs + E1_NPU_PERF_OPS_OFFSET);
	c->perf_errors = readl(npu->regs + E1_NPU_PERF_ERRORS_OFFSET);
	c->perf_unsupported_ops = readl(npu->regs + E1_NPU_PERF_UNSUPPORTED_OPS_OFFSET);
}

static ssize_t e1_npu_read(struct file *file, char __user *buf, size_t len, loff_t *ppos)
{
	struct e1_npu *npu = container_of(file->private_data, struct e1_npu, miscdev);
	u32 value = readl(npu->regs + E1_NPU_RESULT_OFFSET);
	char tmp[16];
	int n = scnprintf(tmp, sizeof(tmp), "0x%08x\n", value);

	return simple_read_from_buffer(buf, len, ppos, tmp, n);
}

static long e1_npu_run_cmd(struct e1_npu *npu, unsigned long arg)
{
	struct e1_npu_cmd cmd;
	u32 status;
	int ret;

	if (copy_from_user(&cmd, (void __user *)arg, sizeof(cmd)))
		return -EFAULT;
	if (cmd.opcode > 0xf)
		return -EINVAL;

	mutex_lock(&npu->lock);
	writel(0, npu->regs + E1_NPU_CMD_PARAM_OFFSET);
	writel(cmd.a, npu->regs + E1_NPU_OP_A_OFFSET);
	writel(cmd.b, npu->regs + E1_NPU_OP_B_OFFSET);
	writel(cmd.acc, npu->regs + E1_NPU_ACC_OFFSET);
	writel(cmd.opcode, npu->regs + E1_NPU_OPCODE_OFFSET);
	writel(E1_NPU_CTRL_DONE, npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
	writel(E1_NPU_CTRL_START, npu->regs + E1_NPU_CTRL_STATUS_OFFSET);

	ret = e1_npu_wait_done(npu, &status);
	cmd.status = status;
	cmd.result = readl(npu->regs + E1_NPU_RESULT_OFFSET);
	mutex_unlock(&npu->lock);
	if (copy_to_user((void __user *)arg, &cmd, sizeof(cmd)))
		return -EFAULT;
	return ret;
}

static void e1_npu_write_scratch_bytes(struct e1_npu *npu, u32 offset,
					  const u8 *data, u32 len)
{
	u32 first_word = offset / 4;
	u32 last_word = (offset + len - 1) / 4;
	u32 word;
	u32 value;
	u32 byte;

	for (word = first_word; word <= last_word; word++) {
		value = readl(npu->regs + E1_NPU_SCRATCH0_OFFSET + word * 4);
		for (byte = 0; byte < 4; byte++) {
			u32 scratch_index = word * 4 + byte;

			if (scratch_index >= offset && scratch_index < offset + len) {
				u32 data_index = scratch_index - offset;

				value &= ~(0xffu << (byte * 8));
				value |= ((u32)data[data_index]) << (byte * 8);
			}
		}
		writel(value, npu->regs + E1_NPU_SCRATCH0_OFFSET + word * 4);
	}
}

static long e1_npu_run_gemm_s8(struct e1_npu *npu, unsigned long arg)
{
	struct e1_npu_gemm_s8 gemm;
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
	if (c_base + c_bytes > E1_NPU_SCRATCH_BYTES)
		return -EINVAL;

	mutex_lock(&npu->lock);
	writel(E1_NPU_CTRL_DONE | E1_NPU_CTRL_ERROR,
	       npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
	for (i = 0; i < E1_NPU_SCRATCH_BYTES; i += 4)
		writel(0, npu->regs + E1_NPU_SCRATCH0_OFFSET + i);

	e1_npu_write_scratch_bytes(npu, 0, (const u8 *)gemm.a, a_bytes);
	e1_npu_write_scratch_bytes(npu, a_bytes, (const u8 *)gemm.b, b_bytes);

	writel(gemm.m | (gemm.n << 8) | (gemm.k << 16), npu->regs + E1_NPU_GEMM_CFG_OFFSET);
	writel((a_bytes << 8) | (c_base << 16), npu->regs + E1_NPU_GEMM_BASE_OFFSET);
	writel(gemm.k | (gemm.n << 8) | ((gemm.n * 4) << 16),
	       npu->regs + E1_NPU_GEMM_STRIDE_OFFSET);
	writel(E1_NPU_OP_GEMM_S8, npu->regs + E1_NPU_OPCODE_OFFSET);
	writel(E1_NPU_CTRL_DONE, npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
	writel(E1_NPU_CTRL_START, npu->regs + E1_NPU_CTRL_STATUS_OFFSET);

	ret = e1_npu_wait_done(npu, &status);
	gemm.status = status;
	for (i = 0; i < gemm.m * gemm.n; i++)
		gemm.c[i] = readl(npu->regs + E1_NPU_SCRATCH0_OFFSET + c_base + i * 4);
	mutex_unlock(&npu->lock);
	if (copy_to_user((void __user *)arg, &gemm, sizeof(gemm)))
		return -EFAULT;
	return ret;
}

static long e1_npu_submit_descriptors(struct e1_npu *npu, unsigned long arg)
{
	struct e1_npu_descriptor_submit submit;
	u32 status;
	int ret;

	if (copy_from_user(&submit, (void __user *)arg, sizeof(submit)))
		return -EFAULT;
	if (submit.base & 0x3)
		return -EINVAL;
	if (submit.head >= E1_NPU_DESC_RING_ENTRIES || submit.tail >= E1_NPU_DESC_RING_ENTRIES)
		return -EINVAL;
	if (submit.head == submit.tail)
		return -EINVAL;

	writel(E1_NPU_DESCRIPTOR_MODE, npu->regs + E1_NPU_CMD_PARAM_OFFSET);
	writel(submit.base, npu->regs + E1_NPU_DESC_BASE_OFFSET);
	writel(submit.head, npu->regs + E1_NPU_DESC_HEAD_OFFSET);
	writel(submit.tail, npu->regs + E1_NPU_DESC_TAIL_OFFSET);
	writel(E1_NPU_CTRL_DONE | E1_NPU_CTRL_ERROR,
	       npu->regs + E1_NPU_CTRL_STATUS_OFFSET);
	writel(E1_NPU_CTRL_START, npu->regs + E1_NPU_CTRL_STATUS_OFFSET);

	ret = e1_npu_wait_done(npu, &status);
	submit.status = readl(npu->regs + E1_NPU_DESC_STATUS_OFFSET);
	submit.bytes_read = readl(npu->regs + E1_NPU_DESC_BYTES_READ_OFFSET);
	submit.bytes_written = readl(npu->regs + E1_NPU_DESC_BYTES_WRITTEN_OFFSET);
	submit.read_beats = readl(npu->regs + E1_NPU_DESC_READ_BEATS_OFFSET);
	submit.write_beats = readl(npu->regs + E1_NPU_DESC_WRITE_BEATS_OFFSET);
	submit.timeout_count = readl(npu->regs + E1_NPU_DESC_TIMEOUT_COUNT_OFFSET);
	if (!submit.status)
		submit.status = status;
	if (copy_to_user((void __user *)arg, &submit, sizeof(submit)))
		return -EFAULT;
	return ret;
}

static long e1_npu_ioctl(struct file *file, unsigned int cmd, unsigned long arg)
{
	struct e1_npu *npu = container_of(file->private_data, struct e1_npu, miscdev);
	struct e1_npu_counters counters;
	struct e1_npu_perf perf;

	switch (cmd) {
	case E1_NPU_IOC_GET_CONTRACT: {
		struct e1_npu_contract contract = {
			.version = E1_CONTRACT_VERSION,
			.npu_base = E1_NPU_BASE,
			.window_bytes = E1_IMPLEMENTED_WINDOW_BYTES,
			.scratch_bytes = E1_NPU_SCRATCH_BYTES,
		};

		if (copy_to_user((void __user *)arg, &contract, sizeof(contract)))
			return -EFAULT;
		return 0;
	}
	case E1_NPU_IOC_RUN_CMD:
		return e1_npu_run_cmd(npu, arg);
	case E1_NPU_IOC_RUN_GEMM_S8:
		return e1_npu_run_gemm_s8(npu, arg);
	case E1_NPU_IOC_SUBMIT_DESCRIPTORS:
		return e1_npu_submit_descriptors(npu, arg);
	case E1_NPU_IOC_GET_PERF:
		perf.cycles = readl(npu->regs + E1_NPU_PERF_CYCLES_OFFSET);
		perf.macs = readl(npu->regs + E1_NPU_PERF_MACS_OFFSET);
		perf.ops = readl(npu->regs + E1_NPU_PERF_OPS_OFFSET);
		perf.errors = readl(npu->regs + E1_NPU_PERF_ERRORS_OFFSET);
		perf.unsupported_ops = readl(npu->regs + E1_NPU_PERF_UNSUPPORTED_OPS_OFFSET);
		if (copy_to_user((void __user *)arg, &perf, sizeof(perf)))
			return -EFAULT;
		return 0;
	case E1_NPU_IOC_GET_COUNTERS:
		e1_npu_fill_counters(npu, &counters);
		if (copy_to_user((void __user *)arg, &counters, sizeof(counters)))
			return -EFAULT;
		return 0;
	default:
		return -ENOTTY;
	}
}

static const struct file_operations e1_npu_fops = {
	.owner = THIS_MODULE,
	.read = e1_npu_read,
	.unlocked_ioctl = e1_npu_ioctl,
	.compat_ioctl = e1_npu_ioctl,
	.llseek = no_llseek,
};

static int e1_npu_probe(struct platform_device *pdev)
{
	struct e1_npu *npu;
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
	npu->miscdev.name = "e1-npu";
	npu->miscdev.fops = &e1_npu_fops;
	npu->miscdev.parent = &pdev->dev;
	platform_set_drvdata(pdev, npu);

	return misc_register(&npu->miscdev);
}

static int e1_npu_remove(struct platform_device *pdev)
{
	struct e1_npu *npu = platform_get_drvdata(pdev);

	misc_deregister(&npu->miscdev);
	return 0;
}

static const struct of_device_id e1_npu_of_match[] = {
	{ .compatible = "eliza,e1-npu" },
	{ }
};
MODULE_DEVICE_TABLE(of, e1_npu_of_match);

static struct platform_driver e1_npu_driver = {
	.probe = e1_npu_probe,
	.remove = e1_npu_remove,
	.driver = {
		.name = "eliza-e1-npu",
		.of_match_table = e1_npu_of_match,
	},
};
module_platform_driver(e1_npu_driver);

MODULE_DESCRIPTION("Eliza e1 NPU contract driver");
MODULE_LICENSE("GPL");
