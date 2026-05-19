/*
 * Tier 1 S-mode payload "E1 from S-mode" via direct UART MMIO.
 *
 * We deliberately bypass SBI console calls and poke the 16550 at
 * 0x10000000 directly so the test does not depend on SBI extension
 * availability. OpenSBI maps PMP so S-mode can access the UART on virt.
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
    uart_puts("E1 from S-mode\n");
    for (;;) {
        __asm__ volatile ("wfi");
    }
}
