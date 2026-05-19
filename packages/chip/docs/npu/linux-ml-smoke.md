# Linux E1-NPU ML Smoke

`/usr/bin/e1-npu-ml-smoke` is the first target-side Linux NPU workload. It
opens `/dev/e1-npu`, runs one bounded `GEMM_S8` tile through
`E1_NPU_IOC_RUN_GEMM_S8`, verifies the exact `2x2x3` output, and prints
counter fields. It rejects CPU-only fallback.

Exact target capture command:

```sh
E1_NPU_ML_SMOKE_CMD='ssh root@TARGET /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu' \
  sw/buildroot/scripts/capture-buildroot-evidence.sh /path/to/buildroot ml-smoke
```

The accepted transcript path is:

```text
docs/evidence/linux/eliza_e1_npu_ml_smoke.log
```

Local source/transcript gate:

```sh
python3 scripts/check_e1_npu_linux_smoke.py
python3 scripts/check_e1_npu_linux_smoke.py --require-pass
```

Current proof boundary: this can prove only Linux driver ioctl execution on the
selected target. It is not Android NNAPI evidence, not hardware benchmark proof,
and not a phone-class accelerator claim.
