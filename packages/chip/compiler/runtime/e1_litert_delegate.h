/*
 * Status: PROTOTYPE. C-style header declaring the LiteRT (TFLite) delegate
 * entry points the e1 NPU exposes to LiteRT. The implementation is a Python
 * skeleton in ``e1_litert_delegate.py`` that reuses the same StableHLO subset
 * validator and partitioner as the ExecuTorch delegate; this header documents
 * the surface a future native delegate library will export.
 *
 * No production LiteRT binding, kernel registration, or TfLiteDelegate object
 * is implemented here. The signatures mirror the upstream
 * ``TfLiteDelegate`` interface so an eventual C implementation can drop in.
 */

#ifndef PACKAGES_CHIP_COMPILER_RUNTIME_E1_LITERT_DELEGATE_H_
#define PACKAGES_CHIP_COMPILER_RUNTIME_E1_LITERT_DELEGATE_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define E1_LITERT_DELEGATE_SCHEMA "eliza.e1_litert_delegate.v1"
#define E1_LITERT_DELEGATE_BACKEND_ID "LITERT_E1_NPU_DELEGATE"
#define E1_LITERT_DELEGATE_STATUS "PROTOTYPE"

/* Opaque delegate handle returned by e1_litert_delegate_create. */
typedef struct E1LiteRtDelegate E1LiteRtDelegate;

/* Per-op partition record produced by e1_litert_delegate_partition. */
typedef struct E1LiteRtPartitionEntry {
  const char* op_name;
  const char* op_kind;
  int32_t supported;
  const char* reason;
  const char* runtime_api;
} E1LiteRtPartitionEntry;

/* Allocate a delegate handle for the bounded StableHLO subset.
 * Returns NULL when the runtime contract cannot be loaded. */
E1LiteRtDelegate* e1_litert_delegate_create(void);

/* Walk the StableHLO subset module pointed to by `module_json` and emit per-op
 * partition records into `entries`. On entry `entries_capacity` is the buffer
 * size; on success `*entries_used` returns the number of records written.
 * Returns 0 on success, non-zero on contract / parse failure. */
int e1_litert_delegate_partition(
    E1LiteRtDelegate* delegate,
    const char* module_json,
    size_t module_json_length,
    E1LiteRtPartitionEntry* entries,
    size_t entries_capacity,
    size_t* entries_used);

/* Invoke the delegate against the partitioned subset and write the placeholder
 * descriptor-spec blob into `blob`. On entry `*blob_size` is the buffer size;
 * on return it carries the bytes written. Returns 0 on success. */
int e1_litert_delegate_invoke(
    E1LiteRtDelegate* delegate,
    const char* module_json,
    size_t module_json_length,
    uint8_t* blob,
    size_t* blob_size);

/* Materialize a descriptor command-buffer image for one descriptor-ready batch
 * into `image_json`. This does not populate tensor data, program MMIO, or
 * submit DMA. */
int e1_litert_delegate_descriptor_command_buffer_image(
    E1LiteRtDelegate* delegate,
    const char* module_json,
    size_t module_json_length,
    uint32_t arena_base,
    uint32_t descriptor_base,
    uint32_t batch_index,
    uint8_t* image_json,
    size_t* image_json_size);

/* Materialize a descriptor command-buffer image for one execution sub-batch
 * into `image_json`. This is used after descriptor_execution_batches split an
 * original batch by GEMM MMIO preamble compatibility. */
int e1_litert_delegate_execution_command_buffer_image(
    E1LiteRtDelegate* delegate,
    const char* module_json,
    size_t module_json_length,
    uint32_t arena_base,
    uint32_t descriptor_base,
    uint32_t execution_batch_index,
    uint8_t* image_json,
    size_t* image_json_size);

/* Prepare the metadata package needed to stage one descriptor-ready batch into
 * `prepared_json`. This includes tensor arena sizing, GEMM MMIO preamble
 * values, and the descriptor image; it does not execute or submit the batch. */
int e1_litert_delegate_prepared_descriptor_batch(
    E1LiteRtDelegate* delegate,
    const char* module_json,
    size_t module_json_length,
    uint32_t arena_base,
    uint32_t descriptor_base,
    uint32_t batch_index,
    uint8_t* prepared_json,
    size_t* prepared_json_size);

/* Prepare the metadata package needed to stage one descriptor execution
 * sub-batch into `prepared_json`. This is used when an original command-buffer
 * batch is split by GEMM MMIO preamble compatibility. */
int e1_litert_delegate_prepared_descriptor_execution_batch(
    E1LiteRtDelegate* delegate,
    const char* module_json,
    size_t module_json_length,
    uint32_t arena_base,
    uint32_t descriptor_base,
    uint32_t execution_batch_index,
    uint8_t* prepared_json,
    size_t* prepared_json_size);

/* Free the delegate handle and any internal partitioner state. */
void e1_litert_delegate_destroy(E1LiteRtDelegate* delegate);

#ifdef __cplusplus
}
#endif

#endif  // PACKAGES_CHIP_COMPILER_RUNTIME_E1_LITERT_DELEGATE_H_
