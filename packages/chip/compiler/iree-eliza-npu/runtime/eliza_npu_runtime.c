/*
 * eliza_npu_runtime.c - reference C implementation of the e1 NPU runtime.
 *
 * Mirrors `submit_descriptors` and `pack_stream_descriptor_word0` from
 * `compiler/runtime/e1_npu_runtime.py`. Any change to one must be matched
 * here.
 */
#include "eliza_npu_runtime.h"

#include <stdint.h>

static int is_aligned32(uint32_t value) { return (value & 0x3u) == 0; }

uint32_t eliza_npu_pack_descriptor_word0(
    uint32_t opcode, uint32_t scratch_offset, uint32_t byte_count,
    int valid_owner, int writeback_request) {
  uint32_t word0 = opcode & 0xFu;
  word0 |= ELIZA_NPU_DESC_FLAG_STREAM_TO_SCRATCH;
  word0 |= (scratch_offset & 0x3Fu) << 16;
  word0 |= (byte_count & 0x3Fu) << 24;
  if (writeback_request) word0 |= ELIZA_NPU_DESC_FLAG_WRITEBACK_REQUEST;
  if (valid_owner) word0 |= ELIZA_NPU_DESC_FLAG_VALID_OWNER;
  return word0;
}

eliza_npu_status_t eliza_npu_pack_descriptor(
    const eliza_npu_descriptor_t *desc,
    eliza_npu_descriptor_words_t *out) {
  if (!desc || !out) return ELIZA_NPU_ERR_REJECTED;
  if (desc->opcode > 0xFu) return ELIZA_NPU_ERR_INVALID_OPCODE;
  if (desc->scratch_offset >= ELIZA_NPU_SCRATCH_BYTES ||
      !is_aligned32(desc->scratch_offset))
    return ELIZA_NPU_ERR_ALIGNMENT;
  if (desc->byte_count == 0 || desc->byte_count > ELIZA_NPU_SCRATCH_BYTES ||
      !is_aligned32(desc->byte_count))
    return ELIZA_NPU_ERR_ALIGNMENT;
  if (desc->scratch_offset + desc->byte_count > ELIZA_NPU_SCRATCH_BYTES)
    return ELIZA_NPU_ERR_SCRATCH_BOUNDS;
  if (desc->flags & ELIZA_NPU_DESC_FLAG_WRITEBACK_REQUEST)
    return ELIZA_NPU_ERR_WRITEBACK_UNSUPPORTED;

  int valid_owner = (desc->flags & ELIZA_NPU_DESC_FLAG_VALID_OWNER) != 0;
  int writeback   = 0;
  out->word0 = eliza_npu_pack_descriptor_word0(
      desc->opcode, desc->scratch_offset, desc->byte_count,
      valid_owner, writeback);
  out->word1 = desc->source_addr;
  out->word2 = desc->op_b;
  out->word3 = desc->acc;
  return ELIZA_NPU_OK;
}

eliza_npu_status_t eliza_npu_submit_descriptors(
    eliza_npu_mmio_t *mmio,
    uint32_t descriptor_ring_base_phys,
    uint32_t head,
    uint32_t tail,
    uint32_t timeout_polls) {
  if (!mmio || !mmio->read32 || !mmio->write32) return ELIZA_NPU_ERR_MMIO;
  if (timeout_polls == 0) return ELIZA_NPU_ERR_REJECTED;
  if ((descriptor_ring_base_phys & 0x3u) != 0) return ELIZA_NPU_ERR_ALIGNMENT;
  if (head >= ELIZA_NPU_DESC_RING_ENTRIES ||
      tail >= ELIZA_NPU_DESC_RING_ENTRIES ||
      head == tail)
    return ELIZA_NPU_ERR_RING_BOUNDS;

  /* Sequence matches E1NpuRuntime.submit_descriptors in
   * compiler/runtime/e1_npu_runtime.py: write DESC_BASE/HEAD/TAIL, set
   * CMD_PARAM=1 (descriptor-mode launch), then ack any prior done/error via
   * CTRL_STATUS=CLEAR_WRITE before issuing the launch via CTRL_STATUS=LAUNCH.
   */
  mmio->write32(ELIZA_NPU_REG_DESC_BASE, descriptor_ring_base_phys, mmio->ctx);
  mmio->write32(ELIZA_NPU_REG_DESC_HEAD, head, mmio->ctx);
  mmio->write32(ELIZA_NPU_REG_DESC_TAIL, tail, mmio->ctx);
  mmio->write32(ELIZA_NPU_REG_CMD_PARAM, 1u, mmio->ctx);
  mmio->write32(ELIZA_NPU_REG_CTRL_STATUS, ELIZA_NPU_CTRL_CLEAR_WRITE, mmio->ctx);
  mmio->write32(ELIZA_NPU_REG_CTRL_STATUS, ELIZA_NPU_CTRL_LAUNCH_WRITE, mmio->ctx);

  for (uint32_t poll = 0; poll < timeout_polls; ++poll) {
    uint32_t status = mmio->read32(ELIZA_NPU_REG_CTRL_STATUS, mmio->ctx);
    if (status & ELIZA_NPU_CTRL_ERROR) return ELIZA_NPU_ERR_REJECTED;
    if (status & ELIZA_NPU_CTRL_DONE) {
      uint32_t desc_status =
          mmio->read32(ELIZA_NPU_REG_DESC_STATUS, mmio->ctx);
      if (desc_status & ELIZA_NPU_DESC_STATUS_ERROR) return ELIZA_NPU_ERR_REJECTED;
      if (desc_status & ELIZA_NPU_DESC_STATUS_WRITEBACK_UNSUPPORTED)
        return ELIZA_NPU_ERR_WRITEBACK_UNSUPPORTED;
      if (desc_status & ELIZA_NPU_DESC_STATUS_TIMEOUT) return ELIZA_NPU_ERR_TIMEOUT;
      if (desc_status & ELIZA_NPU_DESC_STATUS_DONE) return ELIZA_NPU_OK;
    }
  }
  return ELIZA_NPU_ERR_TIMEOUT;
}
