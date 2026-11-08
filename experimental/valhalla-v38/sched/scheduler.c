#include "kernel.h"
#define THREADS 8
#define STACK_SIZE (16*1024)
enum state { UNUSED,READY,RUNNING,DEAD };
struct thread { uint64_t *sp; void (*entry)(void *); void *arg; enum state state; };
static struct thread threads[THREADS];
static size_t current;
_Noreturn static void trampoline(void) { threads[current].entry(threads[current].arg); thread_exit(); }
_Noreturn static void bad_return(void) { panic("thread returned past trampoline"); }
void scheduler_init(void) { memset(threads,0,sizeof threads); current=0; threads[0].state=RUNNING; }
bool thread_create(void (*entry)(void *),void *arg) {
    if(!entry) return false;
    for(size_t i=1;i<THREADS;++i) if(threads[i].state==UNUSED) {
        uint8_t *stack=kmalloc(STACK_SIZE); if(!stack) return false;
        uint64_t *sp=(void *)(stack+STACK_SIZE);
        *--sp=(uintptr_t)bad_return; *--sp=(uintptr_t)trampoline;
        for(unsigned j=0;j<6;++j) *--sp=0;
        threads[i]=(struct thread){.sp=sp,.entry=entry,.arg=arg,.state=READY}; return true;
    }
    return false;
}
void thread_yield(void) {
    size_t previous=current;
    if(threads[previous].state==RUNNING) threads[previous].state=READY;
    for(size_t n=1;n<=THREADS;++n) {
        size_t next=(previous+n)%THREADS;
        if(threads[next].state==READY) {
            current=next; threads[next].state=RUNNING;
            if(next!=previous) context_switch(&threads[previous].sp,threads[next].sp);
            return;
        }
    }
    panic("no runnable thread");
}
_Noreturn void thread_exit(void) { threads[current].state=DEAD; thread_yield(); panic("exited thread resumed"); }
