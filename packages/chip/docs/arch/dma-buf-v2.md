# Android dma-buf v2 + RISC-V IOMMU mapping ABI

The 2028 Eliza phone SoC implements the Android dma-buf v2 mapping ABI on
top of the RISC-V IOMMU v1.0.1 contract (see `docs/arch/iommu.md`). The
combined surface is the only supported path for sharing physical buffers
between the CPU, NPU, GPU, display, camera ISP, and codec engines.

This document defines:

1. The dma-buf v2 user/kernel ABI under RISC-V.
2. The cache-maintenance discipline required by every consumer.
3. Negative test contracts that must fault or be statically forbidden.

## Mapping path

```
gralloc / userspace
   │  dma_buf_export
   ▼
Linux dma-buf core
   │  dma_buf_attach + dma_buf_map_attachment
   ▼
RISC-V IOMMU driver (v6.10+)
   │  iommu_attach_device + iommu_map_sgtable
   │  populates first-stage PTEs; emits IOTINVAL.VMA
   ▼
device DMA / NPU command queue / display fetch
```

The IOMMU manages the device's IOVA space; userspace never touches
physical addresses. Each importing device must be bound to the same DID
(`iommus = <&iommu, did>`) that the kernel driver uses to populate the
device context. Userspace import APIs return the IOVA, which is the
address the device sees on the AXI4 bus.

## Cache-maintenance discipline

Because the SoC is hybrid coherent (CPU L1/L2 is coherent; NPU/GPU read
paths are IO-coherent through SLC; camera/display writes are
non-coherent and use explicit clean/invalidate), every dma-buf operation
must obey:

| Operation | Producer side | Consumer side |
|---|---|---|
| CPU → coherent device (NPU, GPU read) | none | none |
| CPU → non-coherent device (camera, display write) | `DMA_BUF_IOCTL_SYNC` with `SYNC_START\|SYNC_WRITE`; CPU writeback to PoC | none |
| Non-coherent device → CPU | none | `DMA_BUF_IOCTL_SYNC` with `SYNC_START\|SYNC_READ`; CPU invalidate before reading |
| Device → device through SLC | IOMMU `iommu_map` with `IOMMU_CACHE` flag | none |
| Device → device non-coherent | IOMMU `iommu_map`; producer issues `CACHE_CLEAN_LINE` op via QoS class `QOS_DMA_BULK` | none |

The `DMA_BUF_IOCTL_SYNC` ioctl uses the dma-buf v2 layout: the kernel
walks each importer's `dma_buf_attachment::dma_dir` and decides
whether to issue cache maintenance. Userspace can skip the ioctl only
if the producer is fully coherent (CPU writing through L1/L2 to SLC and
the consumer reads from SLC).

## Producer/consumer freshness contract

For every dma-buf, the Eliza HAL guarantees:

* The consumer observes the producer's most recent committed write only
  after the producer has executed:
  * either an architectural store fence (`fence rw,rw`), if the
    consumer is coherent, or
  * a `DMA_BUF_IOCTL_SYNC` with `SYNC_END | SYNC_WRITE`, if the
    consumer is non-coherent.
* The producer never holds a writeable mapping concurrent with a
  consumer's active read pipeline — gralloc enforces this via fences.
* Each dma-buf carries an `explicit-sync` file-descriptor; the consumer
  must wait on the fence before issuing reads.

These are the same requirements as Android dma-buf-v2 on ARM SMMUv3
plus the explicit `IOMMU_CACHE` distinction that RISC-V Sv* PTEs do not
encode.

## Stale-buffer negative test

The `uma-coherency-validation-strategy.yaml` `coherency_policy` axis
mandates a stale-data negative test: if the producer omits the required
`DMA_BUF_IOCTL_SYNC`, the consumer must observe stale data. This is the
only acceptable outcome — silently fixing the omission would mask a real
HAL bug.

Test invocation:

```
make benchmarks-dma-buf-negative
```

Implementation: `benchmarks/memory/dma_buf_negative/`.

## ABI surface

User-space:

* `/dev/dma_heap/system` — vanilla heap, IOMMU-mapped on import.
* `/dev/dma_heap/system-uncached` — IO-coherent, skipped cache
  maintenance for known-coherent flows.
* `/dev/dma_heap/cma` — physically contiguous, primarily for display
  scanout planes when the IOMMU is bypassed for hard real-time fetch.

Kernel:

* `dma_buf_ops::map_dma_buf` — returns an sg_table pinned in DRAM.
* `dma_buf_ops::unmap_dma_buf` — releases the IOMMU mapping.
* `dma_buf_ops::begin_cpu_access` / `end_cpu_access` — issue cache
  maintenance per importer's `dma_dir`.

## IOMMU and bus-master DID assignments

| Bus master | DID | Notes |
|---|---:|---|
| NPU command queue (per context) | `0x0100` – `0x01FF` | PASID partitions per process |
| GPU primary | `0x0200` | shared by all GPU contexts |
| GPU compute | `0x0201` |
| Display plane 0 | `0x0300` | hard real-time QoS |
| Display plane 1 | `0x0301` |
| Camera ISP | `0x0400` |
| Camera CSI rx | `0x0401` |
| Video codec (decode) | `0x0500` |
| Video codec (encode) | `0x0501` |
| DMA controller channels | `0x0600` – `0x06FF` | one DID per channel |
| Debug bridge | `0x07FF` | rejected outside secure mode |

Each DID must be enumerated in the device tree under the IOMMU's
`iommus` references. Closed BSPs that route around the IOMMU will fail
the `iommu_fault_injection_report.json` evidence gate.

## Negative tests

| Test | Expected outcome |
|---|---|
| Producer skips `DMA_BUF_IOCTL_SYNC`, non-coherent consumer reads | consumer sees stale data; test passes |
| Importer attaches with a different DID than its `iommus` binding | kernel returns `-EPERM` from `dma_buf_attach` |
| Userspace maps the dma-buf physically (`mmap` with `MAP_PHYS`) | kernel rejects with `-EACCES`; SELinux denies the cap |
| Bus master issues IOVA outside the dma-buf's IOMMU mapping | IOMMU emits a fault record with the master's DID and the IOVA |
| Concurrent producer write and consumer read without explicit sync fence | gralloc rejects the attach |

## Evidence gate

The fail-closed evidence gate is part of
`docs/evidence/memory/uma-dram-evidence-gate.yaml` under
`blocked_real_claims::android_shared_buffer_uma`. Promotion requires:

1. `benchmarks/memory/dma_buf_negative` produces an evidence JSON
   showing the stale-data outcome under the no-sync path.
2. `verify/cocotb/iommu/test_riscv_iommu.py` passes with the
   unauthorised-DID test.
3. A kernel boot transcript proves the Linux RISC-V IOMMU driver
   attached every required DID.
4. An Android VTS run shows zero closed-BSP dma-buf attaches that
   bypass the IOMMU.

Until those four artifacts exist, every Android shared-buffer claim
stays blocked.
