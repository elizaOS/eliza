/*
 * Eliza E1 NPU MMIO device model.
 *
 * Functional model of rtl/npu/e1_npu.sv for the Eliza E1 SoC. The register
 * map and numeric behaviour mirror the RTL and the platform contract
 * (sw/platform/e1_platform_contract.json). See hw/misc/eliza_e1_npu.c.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#ifndef HW_MISC_ELIZA_E1_NPU_H
#define HW_MISC_ELIZA_E1_NPU_H

#include "hw/sysbus.h"
#include "qom/object.h"

#define TYPE_ELIZA_E1_NPU "eliza.e1-npu"
OBJECT_DECLARE_SIMPLE_TYPE(ElizaE1NpuState, ELIZA_E1_NPU)

#define ELIZA_E1_NPU_SCRATCH_WORDS 16

struct ElizaE1NpuState {
    SysBusDevice parent_obj;

    MemoryRegion iomem;
    qemu_irq irq;
    AddressSpace *dma_as;

    /* Operand / scalar state. */
    uint32_t op_a;
    uint32_t op_b;
    uint32_t acc;
    uint32_t opcode;
    uint32_t result;
    uint32_t result_hi;
    uint32_t status;
    uint32_t cmd_param;

    /* GEMM / vector configuration. */
    uint32_t gemm_cfg;
    uint32_t gemm_bases;
    uint32_t gemm_strides;

    /* Descriptor ring. */
    uint32_t desc_base;
    uint32_t desc_head;
    uint32_t desc_tail;
    uint32_t desc_status;

    /* Performance counters. */
    uint32_t perf_cycles;
    uint32_t perf_macs;
    uint32_t perf_ops;
    uint32_t perf_errors;
    uint32_t perf_unsupported_ops;
    uint32_t desc_timeout_count;
    uint32_t desc_bytes_read;
    uint32_t desc_bytes_written;
    uint32_t desc_read_beats;
    uint32_t desc_write_beats;
    uint32_t perf_stall_cycles;
    uint32_t perf_scratch_bytes;
    uint32_t perf_thermal_throttle;

    uint32_t scratch[ELIZA_E1_NPU_SCRATCH_WORDS];
};

#endif /* HW_MISC_ELIZA_E1_NPU_H */
