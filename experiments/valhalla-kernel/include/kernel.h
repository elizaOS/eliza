#ifndef VALHALLA_KERNEL_H
#define VALHALLA_KERNEL_H
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#define PAGE_SIZE 4096u
#define ABI_VERSION 38u
#define MESSAGE_MAX 96u
#define QUEUE_DEPTH 8u
#define SERVICE_MAX 8u
struct message { uint32_t version, length; unsigned char data[MESSAGE_MAX]; };
struct mailbox { struct message slots[QUEUE_DEPTH]; unsigned head, count; };
struct service { bool used; uint32_t id; struct mailbox inbox; };
enum ipc_status { IPC_OK=0, IPC_INVALID=-1, IPC_FULL=-2, IPC_EMPTY=-3, IPC_MISSING=-4, IPC_EXISTS=-5 };
int service_register(uint32_t id);
int service_send(uint32_t id, const struct message *message);
int service_receive(uint32_t id, struct message *message);
void ipc_init(void);
void *memset(void *dst, int value, size_t size);
void *memcpy(void *dst, const void *src, size_t size);
size_t strlen(const char *text);
void serial_init(void);
void log_text(const char *text);
_Noreturn void panic(const char *text);
void pmm_init(uintptr_t multiboot, uintptr_t kernel_end);
uintptr_t page_alloc(void);
bool page_free(uintptr_t page);
size_t page_available(void);
bool vm_map(uintptr_t address, uintptr_t physical);
bool vm_unmap(uintptr_t address);
uintptr_t vm_lookup(uintptr_t address);
void heap_init(void *base, size_t size);
void *kmalloc(size_t size);
void scheduler_init(void);
int thread_create(void (*entry)(void *), void *argument);
void thread_yield(void);
_Noreturn void thread_exit(void);
static inline void outb(uint16_t port, uint8_t value) { __asm__ volatile("outb %0,%1"::"a"(value),"Nd"(port)); }
static inline uint8_t inb(uint16_t port) { uint8_t value; __asm__ volatile("inb %1,%0":"=a"(value):"Nd"(port)); return value; }
static inline void debug_exit(uint32_t value) { __asm__ volatile("outl %0,%1"::"a"(value),"Nd"((uint16_t)0xf4)); }
#endif
