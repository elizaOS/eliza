/* SPDX-License-Identifier: GPL-2.0-only WITH Linux-syscall-note */
#pragma once

// Local Android copy of the e1 NPU userspace ABI. Keep this in sync with
// sw/linux/drivers/e1/e1-npu-uapi.h until the AOSP tree imports the generated
// kernel UAPI headers directly.

#include <stdint.h>
#include <sys/ioctl.h>

struct e1_npu_contract {
    uint32_t version;
    uint32_t npu_base;
    uint32_t window_bytes;
    uint32_t scratch_bytes;
};

struct e1_npu_cmd {
    uint32_t opcode;
    uint32_t a;
    uint32_t b;
    uint32_t acc;
    uint32_t result;
    uint32_t status;
};

struct e1_npu_gemm_s8 {
    uint32_t m;
    uint32_t n;
    uint32_t k;
    int8_t a[21];
    int8_t b[21];
    int32_t c[9];
    uint32_t status;
};

#define E1_NPU_IOC_MAGIC 'H'
#define E1_NPU_IOC_RUN_CMD \
    _IOWR(E1_NPU_IOC_MAGIC, 0x01, struct e1_npu_cmd)
#define E1_NPU_IOC_RUN_GEMM_S8 \
    _IOWR(E1_NPU_IOC_MAGIC, 0x02, struct e1_npu_gemm_s8)
#define E1_NPU_IOC_GET_CONTRACT \
    _IOR(E1_NPU_IOC_MAGIC, 0x06, struct e1_npu_contract)

#define E1_NPU_OP_RELU4_S8 10u
#define E1_NPU_SCRATCH_BYTES 64u
