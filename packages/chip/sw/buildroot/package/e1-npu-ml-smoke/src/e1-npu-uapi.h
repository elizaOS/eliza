/* SPDX-License-Identifier: GPL-2.0-only WITH Linux-syscall-note */
#ifndef _UAPI_E1_NPU_H
#define _UAPI_E1_NPU_H

#include <stdint.h>
#include <sys/ioctl.h>

typedef uint32_t __u32;
typedef int32_t __s32;
typedef int8_t __s8;

struct e1_npu_contract {
	__u32 version;
	__u32 npu_base;
	__u32 window_bytes;
	__u32 scratch_bytes;
};

struct e1_npu_cmd {
	__u32 opcode;
	__u32 a;
	__u32 b;
	__u32 acc;
	__u32 result;
	__u32 status;
};

struct e1_npu_gemm_s8 {
	__u32 m;
	__u32 n;
	__u32 k;
	__s8 a[21];
	__s8 b[21];
	__s32 c[9];
	__u32 status;
};

struct e1_npu_descriptor_submit {
	__u32 base;
	__u32 head;
	__u32 tail;
	__u32 status;
	__u32 bytes_read;
	__u32 bytes_written;
	__u32 read_beats;
	__u32 write_beats;
	__u32 timeout_count;
};

struct e1_npu_counters {
	__u32 ctrl_status;
	__u32 desc_status;
	__u32 desc_head;
	__u32 desc_tail;
	__u32 desc_timeout_count;
	__u32 desc_bytes_read;
	__u32 desc_bytes_written;
	__u32 desc_read_beats;
	__u32 desc_write_beats;
	__u32 perf_cycles;
	__u32 perf_macs;
	__u32 perf_ops;
	__u32 perf_errors;
	__u32 perf_unsupported_ops;
};

struct e1_npu_perf {
	__u32 cycles;
	__u32 macs;
	__u32 ops;
	__u32 errors;
	__u32 unsupported_ops;
};

#define E1_NPU_IOC_MAGIC 'H'
#define E1_NPU_IOC_RUN_CMD \
	_IOWR(E1_NPU_IOC_MAGIC, 0x01, struct e1_npu_cmd)
#define E1_NPU_IOC_RUN_GEMM_S8 \
	_IOWR(E1_NPU_IOC_MAGIC, 0x02, struct e1_npu_gemm_s8)
#define E1_NPU_IOC_SUBMIT_DESCRIPTORS \
	_IOWR(E1_NPU_IOC_MAGIC, 0x03, struct e1_npu_descriptor_submit)
#define E1_NPU_IOC_GET_COUNTERS \
	_IOR(E1_NPU_IOC_MAGIC, 0x04, struct e1_npu_counters)
#define E1_NPU_IOC_GET_PERF \
	_IOR(E1_NPU_IOC_MAGIC, 0x05, struct e1_npu_perf)
#define E1_NPU_IOC_GET_CONTRACT \
	_IOR(E1_NPU_IOC_MAGIC, 0x06, struct e1_npu_contract)

#define E1_NPU_SCRATCH_BYTES 64u
#define E1_NPU_OP_DOT8_S4 7u
#define E1_NPU_OP_GEMM_S4 9u
#define E1_NPU_OP_RELU4_S8 10u
#define E1_NPU_OP_VRELU_S8 11u
#define E1_NPU_OP_SDOT4_S4_2_4 12u
#define E1_NPU_OP_DOT16_S2 13u
#define E1_NPU_OP_DOT4_FP8_E4M3 14u

#endif /* _UAPI_E1_NPU_H */
