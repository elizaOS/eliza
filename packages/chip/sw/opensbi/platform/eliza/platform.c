// SPDX-License-Identifier: BSD-2-Clause
/*
 * OpenSBI platform glue for the eliza e1_chip_cpu_variant.
 *
 * Single source of truth: sw/platform/e1_platform_contract.json
 *                         (section: e1_chip_cpu_variant)
 *
 *   UART (ns16550a) @ 0x10001000, IRQ 1, clock 50 MHz, baud 115200
 *   PLIC             @ 0x0C000000, 32 sources, 2 contexts (M + S, hart 0)
 *   CLINT            @ 0x02000000, timebase 10 MHz
 *   DRAM             @ 0x80000000, 256 MiB
 *
 * Reference: opensbi/platform/generic and opensbi/platform/template.
 * Copy this directory into <opensbi>/platform/eliza/ and build with:
 *   make PLATFORM=eliza FW_PAYLOAD_PATH=<path/to/Image>
 */

#include <sbi/riscv_asm.h>
#include <sbi/riscv_encoding.h>
#include <sbi/riscv_io.h>
#include <sbi/sbi_const.h>
#include <sbi/sbi_hart.h>
#include <sbi/sbi_platform.h>
#include <sbi_utils/fdt/fdt_helper.h>
#include <sbi_utils/ipi/aclint_mswi.h>
#include <sbi_utils/irqchip/plic.h>
#include <sbi_utils/serial/uart8250.h>
#include <sbi_utils/timer/aclint_mtimer.h>

/* --- Addresses from e1_platform_contract.json :: e1_chip_cpu_variant --- */
#define ELIZA_UART_ADDR        0x10001000UL
#define ELIZA_UART_FREQ        50000000U
#define ELIZA_UART_BAUD        115200U
#define ELIZA_UART_REG_SHIFT   0
#define ELIZA_UART_REG_WIDTH   1
#define ELIZA_UART_IRQ         1

#define ELIZA_PLIC_ADDR        0x0C000000UL
#define ELIZA_PLIC_NUM_SOURCES 32
#define ELIZA_PLIC_NUM_CONTEXTS 2

#define ELIZA_CLINT_ADDR       0x02000000UL
#define ELIZA_CLINT_SIZE       0x00010000UL
#define ELIZA_ACLINT_MTIMER_FREQ 10000000U

#define ELIZA_HART_COUNT       1
#define ELIZA_HART_STACK_SIZE  SBI_PLATFORM_DEFAULT_HART_STACK_SIZE

static struct plic_data plic = {
	.addr = ELIZA_PLIC_ADDR,
	.num_src = ELIZA_PLIC_NUM_SOURCES,
};

static struct aclint_mtimer_data mtimer = {
	.mtime_freq = ELIZA_ACLINT_MTIMER_FREQ,
	.mtime_addr = ELIZA_CLINT_ADDR + CLINT_MTIMER_OFFSET + ACLINT_DEFAULT_MTIME_OFFSET,
	.mtime_size = ACLINT_DEFAULT_MTIME_SIZE,
	.mtimecmp_addr = ELIZA_CLINT_ADDR + CLINT_MTIMER_OFFSET + ACLINT_DEFAULT_MTIMECMP_OFFSET,
	.mtimecmp_size = ACLINT_DEFAULT_MTIMECMP_SIZE,
	.first_hartid = 0,
	.hart_count = ELIZA_HART_COUNT,
	.has_64bit_mmio = true,
};

static struct aclint_mswi_data mswi = {
	.addr = ELIZA_CLINT_ADDR + CLINT_MSWI_OFFSET,
	.size = ACLINT_MSWI_SIZE,
	.first_hartid = 0,
	.hart_count = ELIZA_HART_COUNT,
};

static int eliza_early_init(bool cold_boot)
{
	/*
	 * OpenSBI v1.8.x removed the dedicated .console_init op; a fixed
	 * platform registers its console serial device during cold early-init.
	 * uart8250_init now takes (base, in_freq, baud, reg_shift, reg_width,
	 * reg_offset, caps).
	 */
	if (cold_boot)
		return uart8250_init(ELIZA_UART_ADDR,
				     ELIZA_UART_FREQ,
				     ELIZA_UART_BAUD,
				     ELIZA_UART_REG_SHIFT,
				     ELIZA_UART_REG_WIDTH,
				     0,   /* reg_offset */
				     0);  /* caps */
	return 0;
}

static int eliza_final_init(bool cold_boot)
{
	return 0;
}

/*
 * OpenSBI v1.8.x driver model: the cold-init call registers the device with
 * the core, which then performs per-hart warm init automatically.  The ops
 * are therefore single-shot (no cold_boot argument), and there is no separate
 * .ipi_init member — the ACLINT MSWI (software-interrupt half of the CLINT) is
 * registered alongside the PLIC in irqchip_init.
 */
static int eliza_irqchip_init(void)
{
	int ret;

	ret = plic_cold_irqchip_init(&plic);
	if (ret)
		return ret;

	/* Register the ACLINT MSWI (CLINT software-interrupt half) for IPIs. */
	return aclint_mswi_cold_init(&mswi);
}

static int eliza_timer_init(void)
{
	/* The ACLINT MTIMER (CLINT timer half) drives the SBI timer. */
	return aclint_mtimer_cold_init(&mtimer, NULL);
}

const struct sbi_platform_operations platform_ops = {
	.early_init        = eliza_early_init,
	.final_init        = eliza_final_init,
	.irqchip_init      = eliza_irqchip_init,
	.timer_init        = eliza_timer_init,
};

const struct sbi_platform platform = {
	.opensbi_version   = OPENSBI_VERSION,
	.platform_version  = SBI_PLATFORM_VERSION(0x0, 0x01),
	.name              = "eliza-e1-cpu-variant",
	.features          = SBI_PLATFORM_DEFAULT_FEATURES,
	.hart_count        = ELIZA_HART_COUNT,
	.hart_stack_size   = ELIZA_HART_STACK_SIZE,
	.platform_ops_addr = (unsigned long)&platform_ops,
};
