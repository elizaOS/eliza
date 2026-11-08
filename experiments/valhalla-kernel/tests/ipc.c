#include "kernel.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    ipc_init();
    assert(service_register(0)==IPC_INVALID);
    assert(service_register(1)==IPC_OK);
    assert(service_register(1)==IPC_EXISTS);
    struct message in={.version=ABI_VERSION,.length=1},out;
    assert(service_send(999,&in)==IPC_MISSING);
    assert(service_send(1,NULL)==IPC_INVALID);
    assert(service_receive(1,NULL)==IPC_INVALID);
    assert(service_receive(1,&out)==IPC_EMPTY);
    for(unsigned round=0;round<3;round++) {
        for(unsigned i=0;i<QUEUE_DEPTH;i++) { in.data[0]=(unsigned char)i; assert(service_send(1,&in)==IPC_OK); }
        assert(service_send(1,&in)==IPC_FULL);
        for(unsigned i=0;i<QUEUE_DEPTH;i++) {
            memset(&out,0xff,sizeof out); assert(service_receive(1,&out)==IPC_OK);
            assert(out.data[0]==i && out.length==1 && out.version==ABI_VERSION);
            for(unsigned j=1;j<MESSAGE_MAX;j++) assert(out.data[j]==0);
        }
        assert(service_receive(1,&out)==IPC_EMPTY);
    }
    in.length=MESSAGE_MAX+1; assert(service_send(1,&in)==IPC_INVALID);
    in.length=0;in.version=0;assert(service_send(1,&in)==IPC_INVALID);
    for(unsigned i=2;i<=SERVICE_MAX;i++) assert(service_register(i)==IPC_OK);
    assert(service_register(SERVICE_MAX+1)==IPC_FULL);
    ipc_init(); assert(service_register(1)==IPC_OK);
    puts("PASS daemon validation, FIFO wraparound, saturation, and registration");
}
