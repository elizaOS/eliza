#include "kernel.h"
#define ENTRY_MASK UINT64_C(0x000ffffffffff000)
#define VIRTUAL_MIN ((uintptr_t)1<<30)
#define VIRTUAL_LIMIT ((uintptr_t)1<<47)
/* The boot identity map is immutable. New mappings are supervisor RW, not NX. */
static uint64_t *leaf(uintptr_t va, bool create) {
    uintptr_t cr3; __asm__ volatile("mov %%cr3,%0":"=r"(cr3));
    uint64_t *table=(void *)(cr3&ENTRY_MASK);
    const unsigned shifts[]={39,30,21};
    for(unsigned i=0; i<3; i++) {
        uint64_t *entry=&table[(va>>shifts[i])&511u];
        if(*entry&0x80u) return NULL;
        if(!(*entry&1u)) {
            if(!create) return NULL;
            uintptr_t p=page_alloc(); if(!p) return NULL;
            *entry=p|3u;
        }
        table=(void *)(uintptr_t)(*entry&ENTRY_MASK);
    }
    return &table[(va>>12)&511u];
}
bool vm_map(uintptr_t va, uintptr_t pa) {
    if(va<VIRTUAL_MIN || va>=VIRTUAL_LIMIT || va%PAGE_SIZE || !pa || pa>=VIRTUAL_MIN || pa%PAGE_SIZE) return false;
    uint64_t *p=leaf(va,true); if(!p || (*p&1u)) return false;
    *p=pa|3u; __asm__ volatile("invlpg (%0)"::"r"(va):"memory"); return true;
}
bool vm_unmap(uintptr_t va) {
    if(va<VIRTUAL_MIN || va>=VIRTUAL_LIMIT || va%PAGE_SIZE) return false;
    uint64_t *p=leaf(va,false); if(!p || !(*p&1u)) return false;
    *p=0; __asm__ volatile("invlpg (%0)"::"r"(va):"memory"); return true;
}
uintptr_t vm_lookup(uintptr_t va) {
    if(va<VIRTUAL_MIN || va>=VIRTUAL_LIMIT) return 0;
    uint64_t *p=leaf(va,false); return p && (*p&1u) ? (uintptr_t)(*p&ENTRY_MASK)+(va&4095u) : 0;
}
