/*
 * Tier 1 S-mode payload "E1 from S-mode" via direct UART MMIO.
 *
 * We deliberately bypass SBI console calls and poke the 16550 directly so
 * the test does not depend on SBI extension availability. OpenSBI maps PMP
 * so S-mode can access the UART.
 *
 * The canonical UART base is the e1-chip-variant address (0x10001000) from
 * sw/platform/e1_platform_contract.json (e1_chip_cpu_variant.uart.base),
 * which is the single source of truth for the RTL decode, kernel DTS,
 * U-Boot, OpenSBI, and AOSP HAL. It is the build default below.
 *
 * The stock-QEMU-virt 16550 lives at 0x10000000 (the qemu_virt
 * software_reference_only entry in the same contract). The bring-up harness
 * that boots this payload on `-machine virt` overrides the base by building
 * with -DUART0_BASE=0x10000000UL; it must not be hardcoded here, so the
 * source carries one canonical address and the deviation is explicit.
 */

#include <stdint.h>

#ifndef UART0_BASE
#define UART0_BASE 0x10001000UL
#endif
#define UART_THR   0x0
#define UART_LSR   0x5
#define LSR_THRE   (1u << 5)

static inline void mmio_write8(uint64_t addr, uint8_t val) {
    *(volatile uint8_t *)addr = val;
}

static inline uint8_t mmio_read8(uint64_t addr) {
    return *(volatile uint8_t *)addr;
}

static void uart_putc(char c) {
    while ((mmio_read8(UART0_BASE + UART_LSR) & LSR_THRE) == 0) { }
    mmio_write8(UART0_BASE + UART_THR, (uint8_t)c);
}

static void uart_puts(const char *s) {
    while (*s) uart_putc(*s++);
}

void main(void) {
    /*
     * Distinct, greppable S-mode handoff marker.  Its appearance on the
     * console AFTER the OpenSBI banner is the executable proof that OpenSBI
     * completed the M->S transition and jumped into this S-mode payload.
     */
    uart_puts("S-MODE-OK: E1 reached supervisor mode\n");
    for (;;) {
        __asm__ volatile ("wfi");
    }
}
