#include "kernel.h"
#define PHYS_LIMIT ((uintptr_t)1u<<30)
#define PAGE_COUNT (PHYS_LIMIT/PAGE_SIZE)
static unsigned char used[PAGE_COUNT/8], owned[PAGE_COUNT/8];
static size_t available;
struct tag { uint32_t type, size; };
struct mmap_tag { uint32_t type,size,entry_size,version; };
struct mmap_entry { uint64_t base,length; uint32_t type,reserved; } __attribute__((packed));
static bool bit(unsigned char *map, size_t index) { return (map[index/8]>>(index%8))&1u; }
static void set(unsigned char *map, size_t index, bool value) {
    unsigned char mask=(unsigned char)(1u<<(index%8));
    if(value) map[index/8]|=mask; else map[index/8]&=(unsigned char)~mask;
}
static void reserve(uintptr_t start, uintptr_t end) {
    if(start>=PHYS_LIMIT) return;
    if(end>PHYS_LIMIT) end=PHYS_LIMIT;
    for(size_t i=start/PAGE_SIZE; i<(end+PAGE_SIZE-1)/PAGE_SIZE; i++) {
        if(!bit(used,i)) { set(used,i,true); available--; }
    }
}
void pmm_init(uintptr_t info, uintptr_t kernel_end) {
    memset(used,0xff,sizeof used); memset(owned,0,sizeof owned); available=0;
    if(info>=PHYS_LIMIT-8 || (info&7u)) panic("invalid boot information");
    uint32_t total=*(uint32_t *)info;
    if(total<16 || total>PHYS_LIMIT-info) panic("invalid boot information size");
    uintptr_t end=info+total;
    bool found=false;
    for(uintptr_t p=info+8; p+8<=end;) {
        struct tag *t=(void *)p;
        if(t->size<8 || t->size>end-p) panic("invalid boot tag");
        if(t->type==0) break;
        if(t->type==6) {
            struct mmap_tag *m=(void *)p;
            if(t->size<16 || m->entry_size<sizeof(struct mmap_entry) || (t->size-16)%m->entry_size) panic("invalid memory map");
            for(size_t off=16; off+sizeof(struct mmap_entry)<=t->size; off+=m->entry_size) {
                struct mmap_entry *e=(void *)(p+off);
                if(e->type!=1 || e->base>=PHYS_LIMIT) continue;
                uint64_t limit=e->length>PHYS_LIMIT-e->base ? PHYS_LIMIT : e->base+e->length;
                size_t first=(size_t)((e->base+PAGE_SIZE-1)/PAGE_SIZE),last=(size_t)(limit/PAGE_SIZE);
                for(size_t i=first; i<last; i++) if(bit(used,i)) { set(used,i,false); available++; }
            }
            found=true;
        }
        p+=(t->size+7u)&~(uintptr_t)7u;
    }
    if(!found) panic("boot memory map missing");
    reserve(0,kernel_end); reserve(info,end);
    for(uintptr_t p=info+8; p+8<=end;) {
        struct tag *t=(void *)p;
        if(t->type==0) break;
        if(t->type==3) {
            if(t->size<16) panic("invalid module tag");
            uint32_t *bounds=(void *)(p+8);
            if(bounds[1]<bounds[0]) panic("invalid module bounds");
            reserve(bounds[0],bounds[1]);
        }
        p+=(t->size+7u)&~(uintptr_t)7u;
    }
}
uintptr_t page_alloc(void) {
    for(size_t i=1; i<PAGE_COUNT; i++) if(!bit(used,i)) {
        set(used,i,true); set(owned,i,true); available--;
        uintptr_t p=i*PAGE_SIZE; memset((void *)p,0,PAGE_SIZE); return p;
    }
    return 0;
}
bool page_free(uintptr_t p) {
    if(!p || p>=PHYS_LIMIT || p%PAGE_SIZE || !bit(owned,p/PAGE_SIZE)) return false;
    set(owned,p/PAGE_SIZE,false); set(used,p/PAGE_SIZE,false); available++; return true;
}
size_t page_available(void) { return available; }
