#include "kernel.h"
static struct service services[SERVICE_MAX];
void ipc_init(void) { memset(services,0,sizeof services); }
static struct service *find(uint32_t id) {
    for(unsigned i=0;i<SERVICE_MAX;i++) if(services[i].used && services[i].id==id) return &services[i];
    return NULL;
}
int service_register(uint32_t id) {
    if(!id) return IPC_INVALID;
    if(find(id)) return IPC_EXISTS;
    for(unsigned i=0;i<SERVICE_MAX;i++) if(!services[i].used) {
        services[i].used=true; services[i].id=id; return IPC_OK;
    }
    return IPC_FULL;
}
int service_send(uint32_t id,const struct message *m) {
    if(!m || m->version!=ABI_VERSION || m->length>MESSAGE_MAX) return IPC_INVALID;
    struct service *s=find(id); if(!s) return IPC_MISSING;
    if(s->inbox.count==QUEUE_DEPTH) return IPC_FULL;
    struct message *slot=&s->inbox.slots[(s->inbox.head+s->inbox.count)%QUEUE_DEPTH];
    memset(slot,0,sizeof *slot); slot->version=m->version; slot->length=m->length;
    memcpy(slot->data,m->data,m->length); s->inbox.count++; return IPC_OK;
}
int service_receive(uint32_t id,struct message *m) {
    if(!m) return IPC_INVALID;
    struct service *s=find(id); if(!s) return IPC_MISSING;
    if(!s->inbox.count) return IPC_EMPTY;
    *m=s->inbox.slots[s->inbox.head];
    s->inbox.head=(s->inbox.head+1u)%QUEUE_DEPTH; s->inbox.count--; return IPC_OK;
}
