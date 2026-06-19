// SPDX-License-Identifier: BSD-2-Clause
/*
 * Eliza E1 Demo – OpenSBI platform implementation.
 *
 * Implements the sbi_platform ops for the e1 chip RISC-V SoC:
 *   - Console via e1-uart-1.0 at E1_UART_BASE
 *   - Machine timer via CLINT mtime/mtimecmp at E1_CLINT_BASE
 *   - Software IPI via CLINT msip at E1_CLINT_BASE
 *   - External interrupt enable via PLIC at E1_PLIC_BASE
 *
 * Addresses match sw/platform/e1_platform_contract.json and the
 * Linux DTS at sw/linux/dts/eliza-e1.dts.
 */

#include <sbi/riscv_io.h>
#include <sbi/sbi_console.h>
#include <sbi/sbi_domain.h>
#include <sbi/sbi_error.h>
#include <sbi/sbi_hart.h>
#include <sbi/sbi_hartmask.h>
#include <sbi/sbi_platform.h>
#include <sbi/sbi_scratch.h>
#include <sbi/sbi_timer.h>
#include <sbi/sbi_types.h>
#include <sbi_utils/fdt/fdt_helper.h>
#include <sbi_utils/serial/uart8250.h>

#include "platform.h"

/* -----------------------------------------------------------------------
 * UART console
 * e1-uart-1.0: poll TX_READY in STAT register before writing a byte.
 * getc polls RX_READY; if no byte is available returns -1.
 * ----------------------------------------------------------------------- */

static void e1_uart_putc(char ch)
{
	volatile u32 *stat = (volatile u32 *)(E1_UART_BASE + E1_UART_STAT_OFFSET);
	volatile u32 *tx   = (volatile u32 *)(E1_UART_BASE + E1_UART_TX_OFFSET);

	/* Spin until transmit buffer is ready */
	while (!(readl(stat) & E1_UART_STAT_TX_READY))
		;
	writel((u32)(unsigned char)ch, tx);
}

static int e1_uart_getc(void)
{
	volatile u32 *stat = (volatile u32 *)(E1_UART_BASE + E1_UART_STAT_OFFSET);
	volatile u32 *rx   = (volatile u32 *)(E1_UART_BASE + E1_UART_RX_OFFSET);
	u32 word;

	if (!(readl(stat) & E1_UART_STAT_RX_READY))
		return -1;

	word = readl(rx);
	if (!(word & E1_UART_RX_VALID_BIT))
		return -1;
	return (int)(word & 0xFFU);
}

/* -----------------------------------------------------------------------
 * CLINT – machine timer
 * mtime is a 64-bit counter at CLINT_BASE + MTIME_OFFSET.
 * mtimecmp[hart] is a 64-bit compare at CLINT_BASE + MTIMECMP_OFFSET + 8*hart.
 * Write UINT64_MAX to mtimecmp to suppress the timer interrupt.
 * ----------------------------------------------------------------------- */

static inline volatile u64 *e1_clint_mtime(void)
{
	return (volatile u64 *)(E1_CLINT_BASE + E1_CLINT_MTIME_OFFSET);
}

static inline volatile u64 *e1_clint_mtimecmp(u32 hartid)
{
	return (volatile u64 *)(E1_CLINT_BASE + E1_CLINT_MTIMECMP_OFFSET
	                        + (hartid * 8UL));
}

static inline volatile u32 *e1_clint_msip(u32 hartid)
{
	return (volatile u32 *)(E1_CLINT_BASE + E1_CLINT_MSIP_OFFSET
	                        + (hartid * 4UL));
}

static u64 e1_timer_value(void)
{
	return readq(e1_clint_mtime());
}

static void e1_timer_event_start(u64 next_event)
{
	u32 hartid = current_hartid();
	/*
	 * Write high half first then low half to avoid a spurious interrupt
	 * if the counter crosses the boundary between the two writes.
	 */
	volatile u32 *cmp = (volatile u32 *)e1_clint_mtimecmp(hartid);
	/* Disable by writing max high word first */
	writel(0xFFFFFFFFU, cmp + 1);
	writel((u32)(next_event & 0xFFFFFFFFU), cmp);
	writel((u32)(next_event >> 32), cmp + 1);
}

static void e1_timer_event_stop(void)
{
	u32 hartid = current_hartid();
	volatile u32 *cmp = (volatile u32 *)e1_clint_mtimecmp(hartid);
	writel(0xFFFFFFFFU, cmp);
	writel(0xFFFFFFFFU, cmp + 1);
}

/* -----------------------------------------------------------------------
 * CLINT – IPI (software interrupt)
 * msip[hartid] bit 0 asserts machine software interrupt for that hart.
 * ----------------------------------------------------------------------- */

static void e1_ipi_send(u32 target_hart)
{
	writel(1U, e1_clint_msip(target_hart));
}

static void e1_ipi_clear(u32 target_hart)
{
	writel(0U, e1_clint_msip(target_hart));
}

/* -----------------------------------------------------------------------
 * PLIC – irqchip init
 * Enable all sources so that arriving interrupts reach the hart.
 * Clear any stale pending bits by claiming until no more are pending.
 * ----------------------------------------------------------------------- */

static int e1_irqchip_init(bool cold_boot)
{
	volatile u32 *enable   = (volatile u32 *)(E1_PLIC_BASE + E1_PLIC_ENABLE_OFFSET);
	volatile u32 *claim    = (volatile u32 *)(E1_PLIC_BASE + E1_PLIC_CLAIM_COMPLETE_OFFSET);
	u32 claimed;

	if (!cold_boot)
		return 0;

	/* Enable all implemented sources (bits 0..NUM_SOURCES-1, source N at bit N-1) */
	writel((1U << E1_PLIC_NUM_SOURCES) - 1U, enable);

	/* Drain any stale pending interrupts */
	while ((claimed = readl(claim)) != 0U)
		writel(claimed, claim);

	return 0;
}

/* -----------------------------------------------------------------------
 * Platform early init – runs before sbi_init() clears BSS
 * Minimal: validate magic words in boot ROM, set up hart mask.
 * ----------------------------------------------------------------------- */

static int e1_early_init(bool cold_boot)
{
	volatile u32 *boot_rom = (volatile u32 *)0x00000000UL;
	u32 magic0, magic1;

	if (!cold_boot)
		return 0;

	magic0 = readl(boot_rom + 0);
	magic1 = readl(boot_rom + 1);

	/*
	 * 0x4F50534F = "OPSO", 0x43484950 = "CHIP" – e1 chip identity.
	 * Warn but do not hard-fail; QEMU/Renode may not implement boot ROM.
	 */
	if (magic0 != 0x4F50534FUL || magic1 != 0x43484950UL)
		sbi_printf("e1: boot ROM magic mismatch (0x%08x 0x%08x)\n",
		           magic0, magic1);

	return 0;
}

/* -----------------------------------------------------------------------
 * Platform init – runs after SBI core initializes scratch/console
 * ----------------------------------------------------------------------- */

static int e1_init(bool cold_boot)
{
	if (!cold_boot)
		return 0;

	/* Enable UART output */
	volatile u32 *ctrl = (volatile u32 *)(E1_UART_BASE + E1_UART_CTRL_OFFSET);
	writel(0x1U, ctrl);

	/* Ensure CLINT timer is suppressed until Linux sets it */
	e1_timer_event_stop();

	sbi_printf("\n");
	sbi_printf("Eliza E1 Demo – OpenSBI platform init\n");
	sbi_printf("  CLINT  @ 0x%08lx\n", (unsigned long)E1_CLINT_BASE);
	sbi_printf("  PLIC   @ 0x%08lx  sources=%d\n",
	           (unsigned long)E1_PLIC_BASE, E1_PLIC_NUM_SOURCES);
	sbi_printf("  UART   @ 0x%08lx\n", (unsigned long)E1_UART_BASE);
	sbi_printf("\n");

	return 0;
}

/* -----------------------------------------------------------------------
 * sbi_platform_ops – wired to the ops struct below
 * ----------------------------------------------------------------------- */

static const struct sbi_platform_operations e1_platform_ops = {
	/* Console */
	.console_putc          = e1_uart_putc,
	.console_getc          = e1_uart_getc,

	/* Timer */
	.timer_value           = e1_timer_value,
	.timer_event_start     = e1_timer_event_start,
	.timer_event_stop      = e1_timer_event_stop,

	/* IPI */
	.ipi_send              = e1_ipi_send,
	.ipi_clear             = e1_ipi_clear,

	/* IRQ chip */
	.irqchip_init          = e1_irqchip_init,

	/* Platform lifecycle */
	.early_init            = e1_early_init,
	.final_init            = e1_init,
};

/* -----------------------------------------------------------------------
 * sbi_platform descriptor
 * SBI_PLATFORM_HAS_TIMER_VALUE tells the SBI core that timer_value() is
 * available, so ecall SBI_EXT_TIME is handled via our ops rather than
 * falling back to a CSR read.
 * ----------------------------------------------------------------------- */

const struct sbi_platform platform = {
	.opensbi_version      = OPENSBI_VERSION,
	.platform_version     = SBI_PLATFORM_VERSION(0, 1),
	.name                 = "Eliza E1 Demo",
	.features             = SBI_PLATFORM_HAS_TIMER_VALUE,
	.hart_count           = E1_HART_COUNT,
	.hart_stack_size      = E1_HART_STACK_SIZE,
	.platform_ops_addr    = (unsigned long)&e1_platform_ops,
};
