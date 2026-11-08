#include "kernel.h"
void *memset(void *dst, int value, size_t n) { unsigned char *p=dst; while(n--) *p++=(unsigned char)value; return dst; }
void *memcpy(void *dst, const void *src, size_t n) { unsigned char *d=dst; const unsigned char *s=src; while(n--) *d++=*s++; return dst; }
size_t strlen(const char *s) { size_t n=0; while(s[n]) n++; return n; }
void serial_init(void) {
    outb(0x3f9,0); outb(0x3fb,0x80); outb(0x3f8,3); outb(0x3f9,0);
    outb(0x3fb,3); outb(0x3fa,0xc7); outb(0x3fc,0x0b);
}
void log_text(const char *s) {
    while(*s) {
        unsigned tries=1000000;
        while(!(inb(0x3fd)&0x20) && --tries) __asm__ volatile("pause");
        if(!tries) return;
        outb(0x3f8,(uint8_t)*s++);
    }
}
_Noreturn void panic(const char *s) {
    log_text("PANIC: "); log_text(s); log_text("\n"); debug_exit(2);
    for(;;) __asm__ volatile("cli; hlt");
}
