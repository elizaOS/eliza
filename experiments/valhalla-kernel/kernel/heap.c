#include "kernel.h"
static uintptr_t cursor,limit;
void heap_init(void *base, size_t size) {
    cursor=(uintptr_t)base;
    if(size>UINTPTR_MAX-cursor) panic("heap bounds overflow");
    limit=cursor+size;
}
void *kmalloc(size_t size) {
    if(!size || size>SIZE_MAX-15 || cursor>UINTPTR_MAX-15) return NULL;
    uintptr_t start=(cursor+15u)&~(uintptr_t)15u;
    if(start>limit || size>limit-start) return NULL;
    cursor=start+size; memset((void *)start,0,size); return (void *)start;
}
