# `elizanpu` IREE HAL driver

HAL driver that loads `elizanpu`-compiled `.vmfb` modules and routes dispatches
into the e1 NPU descriptor-ring runtime declared in
[`runtime/eliza_npu_runtime.h`](../../runtime/eliza_npu_runtime.h).

## Status (2026-05-20)

**Scaffold only. No hardware execution.** This driver:

- Registers the `elizanpu` HAL target / device with the IREE compiler and
  runtime, satisfying `--iree-hal-target-backends=elizanpu` and
  `--device=elizanpu`.
- Compiles `elizanpu.gemm_s8` dispatches into a descriptor-table flatbuffer at
  AOT time (this driver is the load-time consumer of that table).
- Provides DMA-buf-style allocator stubs that defer real `dma-buf` handles to a
  kernel driver yet to be written (`drivers/eliza_npu_uapi.h` is the planned
  uapi).
- Provides event-fd-style semaphores that today resolve immediately on the
  host side; the real binding poll-waits on `DESC_STATUS.DONE` per the
  spec-db contract.

Execution paths return `IREE_STATUS_UNAVAILABLE` until the kernel driver and
RTL silicon are wired in. Compile-time paths (descriptor table emission,
module load, semaphore creation, allocator metadata) succeed today so the
ExecuTorch elizanpu backend can flip `blocked_until_built` to `unblocked`.

## Layout

```
hal/elizanpu/
  api.h                       public C ABI (device/driver create + options)
  driver.h        driver.c    driver factory + enumerate
  device.h        device.c    device retain/release, queue ops
  allocator.h     allocator.c DMA-buf staged ring buffer allocator
  buffer.h        buffer.c    HAL buffer wrapping host or dmabuf storage
  command_buffer.h
  command_buffer.c            elizanpu opcode -> descriptor encode + submit
  event.h         event.c     barrier event
  executable.h    executable.c
                              loads the descriptor-table section emitted by
                              elizanpu-emit-descriptor-table
  executable_cache.h
  executable_cache.c          trivial pass-through cache
  semaphore.h     semaphore.c event-fd style waitable
  registration/
    driver_module.h
    driver_module.c           iree_hal_elizanpu_driver_module_register
```

## Build wiring

In-tree (via `scripts/build_iree_eliza_npu.sh`):

```
-DIREE_EXTERNAL_HAL_DRIVERS=elizanpu \
-DIREE_EXTERNAL_ELIZANPU_HAL_DRIVER_TARGET=iree::hal::drivers::elizanpu::registration \
-DIREE_EXTERNAL_ELIZANPU_HAL_DRIVER_REGISTER=iree_hal_elizanpu_driver_module_register \
-DIREE_EXTERNAL_ELIZANPU_HAL_DRIVER_SOURCE_DIR=${REPO}/compiler/iree-eliza-npu/hal/elizanpu
```

The build script symlinks `compiler/iree-eliza-npu/hal/elizanpu` into the IREE
tree at `runtime/src/iree/hal/drivers/elizanpu` alongside the canonical
in-tree drivers.

## Reference

Closest analogs:
- `runtime/src/iree/hal/drivers/null/` — pure skeleton, the structural
  template for this driver.
- IREE PR #18863 (Nordic AXON NPU draft) — descriptor-ring submission pattern.
- IREE Ethos-U TOSA delegate — embedded NPU partition + delegate pattern.
