#include "daemon.h"
struct service { char name[32]; struct v38_message queue[V38_QUEUE_DEPTH]; size_t head,tail,count; };
static struct service services[V38_SERVICES];
void daemon_init(void) { memset(services,0,sizeof services); }
uint32_t daemon_find(const char *name) {
    if(!name) return 0;
    for(size_t i=0;i<V38_SERVICES;++i) if(services[i].name[0] && !strcmp(name,services[i].name)) return (uint32_t)i+1;
    return 0;
}
uint32_t daemon_register(const char *name) {
    if(!name || !*name) return 0;
    size_t n=0; while(n<32 && name[n]) ++n;
    if(n==32 || daemon_find(name)) return 0;
    for(size_t i=0;i<V38_SERVICES;++i) if(!services[i].name[0]) { memcpy(services[i].name,name,n+1); return (uint32_t)i+1; }
    return 0;
}
static struct service *lookup(uint32_t id) { if(!id || id>V38_SERVICES || !services[id-1].name[0]) return NULL; return &services[id-1]; }
enum ipc_result daemon_send(uint32_t id,const struct v38_message *m) {
    if(!m || m->abi!=V38_ABI || m->length>V38_PAYLOAD) return IPC_INVALID;
    struct service *s=lookup(id); if(!s) return IPC_NOT_FOUND;
    if(s->count==V38_QUEUE_DEPTH) return IPC_FULL;
    struct v38_message *dst=&s->queue[s->tail]; memset(dst,0,sizeof *dst);
    dst->abi=m->abi; dst->type=m->type; dst->length=m->length; dst->sender=m->sender; memcpy(dst->payload,m->payload,m->length);
    s->tail=(s->tail+1)%V38_QUEUE_DEPTH; ++s->count; return IPC_OK;
}
enum ipc_result daemon_receive(uint32_t id,struct v38_message *m) {
    if(!m) return IPC_INVALID;
    struct service *s=lookup(id); if(!s) return IPC_NOT_FOUND;
    if(!s->count) return IPC_EMPTY;
    memcpy(m,&s->queue[s->head],sizeof *m); s->head=(s->head+1)%V38_QUEUE_DEPTH; --s->count; return IPC_OK;
}
