#include "kernel.h"
#define HEAP_BASE 0x80000000ULL
#define HEAP_SIZE (256*1024ULL)
static size_t offset;
bool heap_init(void) {
    offset=0;
    for(uintptr_t v=HEAP_BASE;v<HEAP_BASE+HEAP_SIZE;v+=PAGE_SIZE) {
        uintptr_t p=pmm_alloc(); if(!p) return false;
        if(!mmu_map(v,p,true)) { pmm_free(p); return false; }
    }
    return true;
}
void *kmalloc(size_t size) {
    if(!size || size>HEAP_SIZE || size>SIZE_MAX-15) return NULL;
    size=(size+15)&~(size_t)15;
    if(size>HEAP_SIZE-offset) return NULL;
    void *p=(void *)(HEAP_BASE+offset); offset+=size; return p;
}
