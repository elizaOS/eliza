#ifndef V38_KERNEL_H
#define V38_KERNEL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define PAGE_SIZE 4096ULL
#define PHYS_LIMIT (1ULL << 30)
void *memset(void *, int, size_t);
void *memcpy(void *, const void *, size_t);
size_t strlen(const char *);
int strcmp(const char *, const char *);
void serial_init(void);
void serial_write(const char *);
_Noreturn void panic(const char *);
static inline void outb(uint16_t p, uint8_t v) { __asm__ volatile("outb %0,%1"::"a"(v),"Nd"(p)); }
static inline void outl(uint16_t p, uint32_t v) { __asm__ volatile("outl %0,%1"::"a"(v),"Nd"(p)); }
static inline uint8_t inb(uint16_t p) { uint8_t v; __asm__ volatile("inb %1,%0":"=a"(v):"Nd"(p)); return v; }
bool pmm_init(uint32_t magic, uintptr_t info);
uintptr_t pmm_alloc(void);
bool pmm_free(uintptr_t page);
size_t pmm_available(void);
bool mmu_map(uintptr_t virt, uintptr_t phys, bool writable);
bool mmu_unmap(uintptr_t virt, uintptr_t *phys);
bool heap_init(void);
void *kmalloc(size_t size);
void scheduler_init(void);
bool thread_create(void (*entry)(void *), void *arg);
void thread_yield(void);
_Noreturn void thread_exit(void);
void context_switch(uint64_t **old, uint64_t *next);
#endif
