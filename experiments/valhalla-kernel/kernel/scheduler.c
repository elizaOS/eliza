#include "kernel.h"
#define TASK_MAX 8u
#define STACK_SIZE (16u*1024u)
struct task { uintptr_t sp; void (*entry)(void *); void *arg; bool runnable,allocated; };
static struct task tasks[TASK_MAX];
static unsigned current;
extern void context_switch(uintptr_t *old_sp,uintptr_t new_sp);
static _Noreturn void start_thread(void) { tasks[current].entry(tasks[current].arg); thread_exit(); }
void scheduler_init(void) { memset(tasks,0,sizeof tasks); current=0; tasks[0].runnable=true; tasks[0].allocated=true; }
int thread_create(void (*entry)(void *),void *arg) {
    if(!entry) return -1;
    for(unsigned i=1;i<TASK_MAX;i++) if(!tasks[i].allocated) {
        unsigned char *stack=kmalloc(STACK_SIZE); if(!stack) return -1;
        uintptr_t *sp=(uintptr_t *)(stack+STACK_SIZE);
        *--sp=0; *--sp=(uintptr_t)start_thread;
        for(unsigned j=0;j<6;j++) *--sp=0;
        tasks[i]=(struct task){(uintptr_t)sp,entry,arg,true,true}; return (int)i;
    }
    return -1;
}
void thread_yield(void) {
    unsigned old=current;
    for(unsigned offset=1;offset<TASK_MAX;offset++) {
        unsigned next=(old+offset)%TASK_MAX;
        if(tasks[next].runnable) {
            current=next; context_switch(&tasks[old].sp,tasks[next].sp); return;
        }
    }
}
_Noreturn void thread_exit(void) {
    if(current==0) panic("boot thread cannot exit");
    tasks[current].runnable=false; thread_yield(); panic("exited task resumed");
}
