#include "kernel.h"
#define FRAMES (PHYS_LIMIT / PAGE_SIZE)
static uint8_t used[FRAMES/8], allowed[FRAMES/8];
static size_t free_count, cursor;
extern unsigned char kernel_end[];
struct tag { uint32_t type,size; };
struct mmap_tag { uint32_t type,size,entry_size,version; };
struct mmap_entry { uint64_t address,length; uint32_t type,reserved; } __attribute__((packed));
static bool bit(uint8_t *m,size_t n) { return (m[n/8]>>(n%8))&1; }
static void set(uint8_t *m,size_t n,bool v) { if(v) m[n/8]|=(uint8_t)(1u<<(n%8)); else m[n/8]&=(uint8_t)~(1u<<(n%8)); }
static void reserve(uint64_t start,uint64_t end) {
    if(start>=PHYS_LIMIT) return;
    if(end>PHYS_LIMIT) end=PHYS_LIMIT;
    for(size_t i=start/PAGE_SIZE;i<(end+PAGE_SIZE-1)/PAGE_SIZE;++i) {
        if(!bit(used,i)) { set(used,i,true); --free_count; }
        set(allowed,i,false);
    }
}
bool pmm_init(uint32_t magic,uintptr_t info) {
    if(magic!=0x36d76289 || (info&7) || info>PHYS_LIMIT-8) return false;
    uint32_t total=*(uint32_t *)info;
    if(total<16 || total>PHYS_LIMIT-info || (total&7)) return false;
    memset(used,0xff,sizeof used); memset(allowed,0,sizeof allowed); free_count=0; cursor=0;
    bool found=false,ended=false;
    uintptr_t end=info+total;
    for(uintptr_t at=info+8;at<=end-8;) {
        const struct tag *t=(const void *)at;
        if(t->size<8 || t->size>end-at) return false;
        if(t->type==0) { if(t->size!=8) return false; ended=true; break; }
        if(t->type==6) {
            if(t->size<16) return false;
            const struct mmap_tag *m=(const void *)at;
            if(m->entry_size<sizeof(struct mmap_entry) || m->version!=0 || (t->size-16)%m->entry_size) return false;
            found=true;
            for(uintptr_t p=at+16;p<at+t->size;p+=m->entry_size) {
                const struct mmap_entry *e=(const void *)p;
                if(e->type!=1 || e->address>=PHYS_LIMIT) continue;
                uint64_t limit=e->length>PHYS_LIMIT-e->address?PHYS_LIMIT:e->address+e->length;
                for(size_t i=(e->address+PAGE_SIZE-1)/PAGE_SIZE;i<limit/PAGE_SIZE;++i) {
                    if(bit(used,i)) { set(used,i,false); set(allowed,i,true); ++free_count; }
                }
            }
        }
        uintptr_t step=((uintptr_t)t->size+7)&~(uintptr_t)7;
        if(step>end-at) return false;
        at+=step;
    }
    if(!found || !ended) return false;
    reserve(0,(uintptr_t)kernel_end); reserve(info,end);
    for(uintptr_t at=info+8;at<=end-8;) {
        const struct tag *t=(const void *)at;
        if(t->type==0) break;
        if(t->type==3) {
            if(t->size<16) return false;
            const uint32_t *v=(const void *)(at+8);
            if(v[1]<v[0]) return false;
            reserve(v[0],v[1]);
        }
        at+=((uintptr_t)t->size+7)&~(uintptr_t)7;
    }
    return free_count>128;
}
uintptr_t pmm_alloc(void) {
    if(!free_count) return 0;
    for(size_t n=0;n<FRAMES;++n) {
        size_t i=(cursor+n)%FRAMES;
        if(!bit(used,i)) { set(used,i,true); --free_count; cursor=(i+1)%FRAMES; uintptr_t p=i*PAGE_SIZE; memset((void *)p,0,PAGE_SIZE); return p; }
    }
    return 0;
}
bool pmm_free(uintptr_t page) {
    size_t i=page/PAGE_SIZE;
    if((page&(PAGE_SIZE-1)) || i>=FRAMES || !bit(allowed,i) || !bit(used,i)) return false;
    set(used,i,false); ++free_count; return true;
}
size_t pmm_available(void) { return free_count; }
