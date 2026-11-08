#include "daemon.h"
static uint32_t logger;
static unsigned received;
static bool producer_done;
#define CHECK(condition) do { if(!(condition)) panic(#condition); } while(0)
static void selftest(void) {
    size_t before=pmm_available(); uintptr_t p=pmm_alloc(),q=pmm_alloc();
    CHECK(p && q && p!=q && !(p&(PAGE_SIZE-1)));
    for(size_t i=0;i<PAGE_SIZE;++i) CHECK(((uint8_t *)p)[i]==0);
    CHECK(mmu_map(0x40000000,p,true)); CHECK(!mmu_map(0x40000000,q,true));
    *(volatile uint64_t *)0x40000000=0x563338;
    CHECK(*(volatile uint64_t *)p==0x563338);
    uintptr_t old=0; CHECK(mmu_unmap(0x40000000,&old) && old==p); CHECK(!mmu_unmap(0x40000000,NULL));
    CHECK(!pmm_free(p+1)); CHECK(pmm_free(p)); CHECK(!pmm_free(p)); CHECK(pmm_free(q));
    CHECK(pmm_available()<=before); CHECK(!kmalloc(SIZE_MAX)); CHECK(!kmalloc(0));
    CHECK(((uintptr_t)kmalloc(17)&15)==0);
    serial_write("PASS physical allocator, virtual alias, unmap, heap\n");
    uint32_t id=daemon_register("selftest"); CHECK(id && !daemon_register("selftest") && daemon_find("selftest")==id);
    struct v38_message m={.abi=V38_ABI,.type=7,.length=1,.payload={42}},out;
    CHECK(daemon_receive(id,&out)==IPC_EMPTY);
    m.abi=37; CHECK(daemon_send(id,&m)==IPC_INVALID); m.abi=V38_ABI;
    m.length=V38_PAYLOAD+1; CHECK(daemon_send(id,&m)==IPC_INVALID);m.length=1;
    CHECK(daemon_send(0,&m)==IPC_NOT_FOUND);
    for(unsigned i=0;i<V38_QUEUE_DEPTH;++i) { m.sender=i; CHECK(daemon_send(id,&m)==IPC_OK); }
    CHECK(daemon_send(id,&m)==IPC_FULL);
    for(unsigned i=0;i<V38_QUEUE_DEPTH;++i) { CHECK(daemon_receive(id,&out)==IPC_OK); CHECK(out.sender==i && out.payload[0]==42); }
    CHECK(daemon_receive(id,&out)==IPC_EMPTY);
    CHECK(daemon_send(id,&m)==IPC_OK && daemon_receive(id,&out)==IPC_OK);
    serial_write("PASS daemon ABI, FIFO, queue saturation, wraparound\n");
}
static void logger_task(void *arg) {
    (void)arg; struct v38_message m;
    for(;;) { if(daemon_receive(logger,&m)==IPC_OK) { for(uint32_t i=0;i<m.length;++i) { char s[2]={(char)m.payload[i],0};serial_write(s); } serial_write("\n");++received; } thread_yield(); }
}
static void worker_task(void *arg) {
    (void)arg; const char text[]="worker says hello";
    struct v38_message m={.abi=V38_ABI,.type=1,.length=sizeof(text)-1,.sender=1};memcpy(m.payload,text,sizeof(text)-1);
    for(unsigned i=0;i<3;++i) { CHECK(daemon_send(logger,&m)==IPC_OK); thread_yield(); }
    producer_done=true;
}
void kernel_main(uint32_t magic,uintptr_t info) {
    serial_init(); serial_write("ValhallaOS V38 educational baseline\n");
    CHECK(pmm_init(magic,info)); CHECK(heap_init()); daemon_init(); selftest(); scheduler_init();
    logger=daemon_register("logger"); CHECK(logger);CHECK(thread_create(logger_task,NULL));CHECK(thread_create(worker_task,NULL));
    serial_write("memory ready; scheduler ready; logger registered\n");
    bool reported=false;
    for(;;) {
        thread_yield();
        if(!reported && producer_done && received==3) { serial_write("PASS cooperative context switch and thread exit\nV38_SMOKE_PASS\n"); reported=true;outl(0xf4,0x10); }
        __asm__ volatile("pause");
    }
}
