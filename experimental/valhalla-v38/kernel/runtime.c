#include "kernel.h"
void *memset(void *dst, int c, size_t n) { unsigned char *p=dst; while(n--) *p++=(unsigned char)c; return dst; }
void *memcpy(void *dst, const void *src, size_t n) { unsigned char *d=dst; const unsigned char *s=src; while(n--) *d++=*s++; return dst; }
size_t strlen(const char *s) { size_t n=0; while(s[n]) ++n; return n; }
int strcmp(const char *a,const char *b) { while(*a && *a==*b) { ++a; ++b; } return (unsigned char)*a-(unsigned char)*b; }
void serial_init(void) {
    outb(0x3f9,0); outb(0x3fb,0x80); outb(0x3f8,3); outb(0x3f9,0);
    outb(0x3fb,3); outb(0x3fa,0xc7); outb(0x3fc,0x0b);
}
void serial_write(const char *s) {
    while(*s) { if(*s=='\n') { while(!(inb(0x3fd)&0x20)) {} outb(0x3f8,'\r'); }
        while(!(inb(0x3fd)&0x20)) {} outb(0x3f8,(uint8_t)*s++); }
}
_Noreturn void panic(const char *s) { serial_write("PANIC: "); serial_write(s); serial_write("\n"); outl(0xf4,0x11); for(;;) __asm__ volatile("cli; hlt"); }
