#ifndef V38_DAEMON_H
#define V38_DAEMON_H
#include "kernel.h"
#define V38_ABI 38u
#define V38_PAYLOAD 96u
#define V38_QUEUE_DEPTH 8u
#define V38_SERVICES 8u
struct v38_message { uint16_t abi, type; uint32_t length; uint64_t sender; uint8_t payload[V38_PAYLOAD]; };
_Static_assert(sizeof(struct v38_message) == 112, "message ABI changed");
enum ipc_result { IPC_OK, IPC_INVALID, IPC_NOT_FOUND, IPC_FULL, IPC_EMPTY };
void daemon_init(void);
uint32_t daemon_register(const char *name);
uint32_t daemon_find(const char *name);
enum ipc_result daemon_send(uint32_t id, const struct v38_message *message);
enum ipc_result daemon_receive(uint32_t id, struct v38_message *message);
#endif
