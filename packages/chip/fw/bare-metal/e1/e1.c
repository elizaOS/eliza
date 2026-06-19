/*
 * Tier 0 bare-metal "E1" for QEMU virt.
 *
 * QEMU virt 16550A UART base = 0x10000000. We poll LSR (offset 5) bit 5
 * (THR empty) before writing each byte to THR (offset 0). After printing
 * we wfi-loop forever.
 *
 * NOTE: QEMU virt UART lives at 0x10000000. Our project platform contract
 * (sw/platform/e1_platform_contract.json) puts the UART at 0x10001000.
 * Tier 0 deliberately targets stock QEMU virt so we can validate boot
 * without a custom machine; later tiers will switch to 0x10001000.
 */

#include <stdint.h>

#define UART0_BASE 0x10000000UL
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
    uart_puts("E1\n");
    for (;;) {
        __asm__ volatile ("wfi");
    }
}
