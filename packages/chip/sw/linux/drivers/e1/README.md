# e1 NPU Linux Driver ABI

This driver exposes the prototype e1 NPU MMIO block as `/dev/e1-npu`.
The ABI is intentionally small and fail-closed: userspace can submit scalar
commands, submit one bounded INT8 GEMM tile, and read hardware performance
counters. It is sufficient for a Linux userspace ML smoke, but it is not a
TensorFlow Lite, NNAPI, IREE, or production compiler ABI.

## Device Node

- Driver compatible: `eliza,e1-npu`
- Device node: `/dev/e1-npu`
- Backing MMIO base: `E1_NPU_BASE`
- Implemented MMIO window: 256 bytes
- Scratchpad window: 64 bytes at `E1_NPU_SCRATCH0_OFFSET`

The legacy `read(2)` path returns the current `RESULT` register as text. New
runtime smoke commands must use the ioctls below.

## Ioctls

All structs use Linux fixed-width integer types and native kernel ioctl layout.
The Python reference runtime computes the same request numbers in
`compiler/runtime/e1_npu_runtime.py`.

```c
#define E1_NPU_IOC_MAGIC 'H'
#define E1_NPU_IOC_RUN_CMD _IOWR(E1_NPU_IOC_MAGIC, 0x01, struct e1_npu_cmd)
#define E1_NPU_IOC_RUN_GEMM_S8 _IOWR(E1_NPU_IOC_MAGIC, 0x02, struct e1_npu_gemm_s8)
#define E1_NPU_IOC_GET_PERF _IOR(E1_NPU_IOC_MAGIC, 0x03, struct e1_npu_perf)
```

`E1_NPU_IOC_RUN_CMD` submits scalar opcodes such as `DOT4_S8`:

```c
struct e1_npu_cmd {
        __u32 opcode;
        __u32 a;
        __u32 b;
        __u32 acc;
        __u32 result;
        __u32 status;
};
```

`E1_NPU_IOC_RUN_GEMM_S8` submits one bounded INT8 tile:

```c
struct e1_npu_gemm_s8 {
        __u32 m;
        __u32 n;
        __u32 k;
        __s8 a[21];
        __s8 b[21];
        __s32 c[9];
        __u32 status;
};
```

Accepted GEMM dimensions are `1 <= M,N <= 3` and `1 <= K <= 7`. The driver
packs A and B into the 64-byte scratchpad and returns C as signed int32. Any
dimension that cannot fit the scratchpad returns `-EINVAL` before launching
hardware.

`E1_NPU_IOC_GET_PERF` returns the counter registers:

```c
struct e1_npu_perf {
        __u32 cycles;
        __u32 macs;
        __u32 ops;
        __u32 errors;
        __u32 unsupported_ops;
};
```

## Userspace Smoke Command

Run this only on a Linux target with the driver loaded and `/dev/e1-npu`
present:

```sh
python3 compiler/runtime/e1_npu_runtime.py smoke \
  --backend=linux-ioctl \
  --device=/dev/e1-npu \
  --case=all
```

The command emits JSON with schema `eliza.e1_npu_runtime_smoke.v1`.
Without the device node it exits non-zero with `status=blocked` and
`blocked_reason=missing_device_node`. That blocked result is expected on host
machines and must not be converted into hardware evidence.

The matching benchmark plan entry is `e1_npu_linux_runtime_smoke`. It proves
only that handwritten DOT4_S8 and GEMM_S8 vectors can run through the Linux
driver/runtime path. It does not prove TFLite delegation, NNAPI acceleration,
large tensor DMA, sustained performance, or phone-comparable TOPS.
