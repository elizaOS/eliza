#include "kernel.h"
extern unsigned char _kernel_end[];
static bool producer_done,logger_done;
static unsigned received;
static void require(bool ok,const char *text) { if(!ok) panic(text); }
static void logger(void *arg) {
    (void)arg;
    for(;;) {
        struct message m;
        int r=service_receive(1,&m);
        if(r==IPC_OK) {
            require(m.length==18,"daemon length");
            char text[MESSAGE_MAX+1]; memcpy(text,m.data,m.length); text[m.length]=0;
            log_text(text); received++;
        } else require(r==IPC_EMPTY,"daemon receive");
        if(producer_done && received==3) break;
        thread_yield();
    }
    logger_done=true;
}
static void producer(void *arg) {
    (void)arg;
    struct message m={.version=ABI_VERSION,.length=18,.data="worker says hello\n"};
    for(unsigned i=0;i<3;i++) { require(service_send(1,&m)==IPC_OK,"daemon send"); thread_yield(); }
    producer_done=true;
}
void kernel_main(uint32_t magic,uintptr_t info) {
    serial_init(); log_text("ValhallaOS V38 educational baseline\n");
    require(magic==0x36d76289u,"Multiboot2 magic");
    pmm_init(info,(uintptr_t)_kernel_end);
    size_t before=page_available(); require(before>128,"insufficient physical pages");
    uintptr_t a=page_alloc(),b=page_alloc();
    require(a && b && a!=b && !(a%PAGE_SIZE) && !(b%PAGE_SIZE),"physical allocation");
    require(!page_free(a+1) && !page_free(0),"invalid page free");
    *(volatile uint64_t *)a=UINT64_C(0x123456789abc);
    require(page_free(a) && !page_free(a),"physical free ownership");
    a=page_alloc(); require(a && *(volatile uint64_t *)a==0,"zeroed physical page");
    uintptr_t alias=UINT64_C(0x50000000);
    require(!vm_map(0x1000,a) && !vm_map(alias+1,a),"mapping boundary");
    require(vm_map(alias,a) && !vm_map(alias,b),"mapping collision");
    *(volatile uint64_t *)alias=UINT64_C(0xc0decafe);
    require(*(volatile uint64_t *)a==UINT64_C(0xc0decafe),"virtual alias");
    require(vm_lookup(alias+13)==a+13,"virtual lookup");
    require(vm_unmap(alias) && !vm_unmap(alias) && !vm_lookup(alias),"virtual unmap");
    require(page_free(a) && page_free(b),"physical cleanup");
    log_text("PASS physical memory and virtual mapping\n");
    uintptr_t heap=UINT64_C(0x40000000);
    for(unsigned i=0;i<64;i++) { uintptr_t p=page_alloc(); require(p && vm_map(heap+i*PAGE_SIZE,p),"heap mapping"); }
    heap_init((void *)heap,64u*PAGE_SIZE);
    void *aligned=kmalloc(17); require(aligned && !((uintptr_t)aligned%16) && !kmalloc(SIZE_MAX),"heap boundaries");
    ipc_init(); require(service_register(1)==IPC_OK,"service registration");
    require(service_register(1)==IPC_EXISTS,"duplicate service");
    struct message m={.version=ABI_VERSION,.length=1,.data={42}},out;
    for(unsigned i=0;i<QUEUE_DEPTH;i++) require(service_send(1,&m)==IPC_OK,"queue fill");
    require(service_send(1,&m)==IPC_FULL,"queue saturation");
    for(unsigned i=0;i<QUEUE_DEPTH;i++) require(service_receive(1,&out)==IPC_OK && out.data[0]==42,"queue FIFO");
    require(service_receive(1,&out)==IPC_EMPTY,"empty queue");
    m.version=0; require(service_send(1,&m)==IPC_INVALID,"ABI validation");
    log_text("PASS heap and daemon boundaries\n");
    scheduler_init(); require(thread_create(logger,NULL)>0 && thread_create(producer,NULL)>0,"thread create");
    log_text("memory ready; scheduler ready; logger registered\n");
    while(!logger_done) thread_yield();
    /* Both service tasks have returned through thread_exit by this point. */
    require(producer_done && received==3,"scheduler round robin");
    log_text("PASS scheduler and daemon delivery\nSELFTEST PASS\n");
    debug_exit(0);
    for(;;) __asm__ volatile("cli; hlt");
}
