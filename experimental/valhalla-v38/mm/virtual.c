#include "kernel.h"
#define ADDR 0x000ffffffffff000ULL
static uint64_t *leaf(uintptr_t virt,bool create) {
    uintptr_t cr3; __asm__ volatile("mov %%cr3,%0":"=r"(cr3));
    uint64_t *table=(void *)(cr3&ADDR);
    const unsigned shifts[]={39,30,21};
    for(size_t i=0;i<3;++i) {
        uint64_t *entry=&table[(virt>>shifts[i])&511];
        if(*entry&0x80) return NULL;
        if(!(*entry&1)) {
            if(!create) return NULL;
            uintptr_t page=pmm_alloc(); if(!page) return NULL;
            *entry=page|3;
        }
        table=(void *)(*entry&ADDR);
    }
    return &table[(virt>>12)&511];
}
bool mmu_map(uintptr_t virt,uintptr_t phys,bool writable) {
    if(virt>=(1ULL<<47) || ((virt|phys)&(PAGE_SIZE-1)) || phys>=PHYS_LIMIT) return false;
    uint64_t *entry=leaf(virt,true); if(!entry || (*entry&1)) return false;
    *entry=phys|1|(writable?2:0); __asm__ volatile("invlpg (%0)"::"r"(virt):"memory"); return true;
}
bool mmu_unmap(uintptr_t virt,uintptr_t *phys) {
    if(virt>=(1ULL<<47) || (virt&(PAGE_SIZE-1))) return false;
    uint64_t *entry=leaf(virt,false); if(!entry || !(*entry&1)) return false;
    if(phys) *phys=*entry&ADDR;
    *entry=0; __asm__ volatile("invlpg (%0)"::"r"(virt):"memory"); return true;
}
