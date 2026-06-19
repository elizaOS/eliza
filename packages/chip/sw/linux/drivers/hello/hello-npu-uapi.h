/* SPDX-License-Identifier: GPL-2.0-only WITH Linux-syscall-note */
#ifndef _UAPI_HELLO_NPU_H
#define _UAPI_HELLO_NPU_H

#ifdef __KERNEL__
#include <linux/ioctl.h>
#include <linux/types.h>
#else
#include <stdint.h>
#include <sys/ioctl.h>
typedef uint32_t __u32;
typedef int32_t __s32;
typedef int8_t __s8;
#endif

struct hello_npu_contract {
	__u32 version;
	__u32 npu_base;
	__u32 window_bytes;
	__u32 scratch_bytes;
};

struct hello_npu_gemm_s8 {
	__u32 m;
	__u32 n;
	__u32 k;
	__s8 a[21];
	__s8 b[21];
	__s32 c[9];
	__u32 status;
};

struct hello_npu_descriptor_submit {
	__u32 base;
	__u32 head;
	__u32 tail;
	__u32 status;
	__u32 bytes_read;
	__u32 timeout_count;
};

struct hello_npu_counters {
	__u32 ctrl_status;
	__u32 desc_status;
	__u32 desc_head;
	__u32 desc_tail;
	__u32 desc_timeout_count;
	__u32 desc_bytes_read;
	__u32 perf_cycles;
	__u32 perf_macs;
	__u32 perf_ops;
	__u32 perf_errors;
	__u32 perf_unsupported_ops;
};

#define HELLO_NPU_IOC_MAGIC 'H'
#define HELLO_NPU_IOC_RUN_GEMM_S8 \
	_IOWR(HELLO_NPU_IOC_MAGIC, 0x02, struct hello_npu_gemm_s8)
#define HELLO_NPU_IOC_SUBMIT_DESCRIPTORS \
	_IOWR(HELLO_NPU_IOC_MAGIC, 0x03, struct hello_npu_descriptor_submit)
#define HELLO_NPU_IOC_GET_COUNTERS \
	_IOR(HELLO_NPU_IOC_MAGIC, 0x04, struct hello_npu_counters)
#define HELLO_NPU_IOC_GET_CONTRACT \
	_IOR(HELLO_NPU_IOC_MAGIC, 0x06, struct hello_npu_contract)

#define HELLO_NPU_CTRL_START 0x1u
#define HELLO_NPU_CTRL_DONE 0x2u
#define HELLO_NPU_CTRL_ERROR 0x4u
#define HELLO_NPU_DEFAULT_POLL_LIMIT 100000u
#define HELLO_NPU_OP_GEMM_S8 8u
#define HELLO_NPU_DESCRIPTOR_MODE 1u
#define HELLO_NPU_DESC_RING_ENTRIES 8u
#define HELLO_NPU_SCRATCH_BYTES 64u

#endif
