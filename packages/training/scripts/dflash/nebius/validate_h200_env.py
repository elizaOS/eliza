#!/usr/bin/env python3
"""Pre-flight validator for the Nebius H200 training environment.

Checks:
  1. CUDA device is H200 (torch.cuda.get_device_name() contains "H200")
  2. Flash attention 2 is importable
  3. APOLLO (apollo-torch) is importable
  4. nvidia-smi shows >=140 GB VRAM (141 GB HBM3e)
  5. BF16 is supported on the device

Prints PASS/FAIL for each check and exits:
  0  all checks pass
  1  one or more checks failed
"""

from __future__ import annotations

import shutil
import subprocess
import sys


def _check(label: str, fn) -> bool:
    try:
        result = fn()
        if result is True or result is None:
            print(f"  PASS  {label}")
            return True
        if isinstance(result, str):
            print(f"  PASS  {label}: {result}")
            return True
        print(f"  FAIL  {label}: {result}")
        return False
    except Exception as exc:
        print(f"  FAIL  {label}: {exc}")
        return False


def check_h200() -> str:
    import torch  # noqa: PLC0415

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA not available — is this an H200 instance?")
    name = torch.cuda.get_device_name(0)
    if "H200" not in name:
        raise RuntimeError(
            f"Expected H200 GPU, got: {name!r}. "
            "Set instance type to gpu-h200-sxm on Nebius."
        )
    return name


def check_flash_attn() -> str:
    import flash_attn  # noqa: PLC0415

    return f"flash_attn {flash_attn.__version__}"


def check_apollo() -> str:
    import apollo_torch  # noqa: PLC0415

    ver = getattr(apollo_torch, "__version__", "unknown")
    # Confirm the APOLLO class is importable (the actual import path varies by
    # version; try both common locations).
    try:
        from apollo_torch import APOLLO  # noqa: PLC0415, F401
    except ImportError:
        from apollo_torch.apollo import APOLLO  # noqa: PLC0415, F401
    return f"apollo_torch {ver}"


def check_nvidia_smi_vram() -> str:
    if not shutil.which("nvidia-smi"):
        raise RuntimeError("nvidia-smi not found in PATH")
    out = subprocess.check_output(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ],
        text=True,
    ).strip()
    # Each line: "NVIDIA H200 SXM5, 143771" (MiB)
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    if not lines:
        raise RuntimeError("nvidia-smi returned no GPU rows")
    gpu_name, mem_str = lines[0].rsplit(",", 1)
    mem_mib = int(mem_str.strip())
    mem_gb = mem_mib / 1024
    # H200 SXM5 is 141 GB HBM3e; nvidia-smi typically reports ~143 GiB.
    if mem_gb < 140:
        raise RuntimeError(
            f"Expected >=140 GB VRAM (H200 HBM3e), got {mem_gb:.1f} GB "
            f"on {gpu_name.strip()!r}"
        )
    return f"{gpu_name.strip()}: {mem_gb:.1f} GB"


def check_bf16() -> str:
    import torch  # noqa: PLC0415

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA not available")
    if not torch.cuda.is_bf16_supported():
        raise RuntimeError("BF16 not supported on this device")
    return "BF16 supported"


def main() -> int:
    print("H200 environment validation")
    print("=" * 40)

    checks = [
        ("CUDA device is H200", check_h200),
        ("FlashAttention2 importable", check_flash_attn),
        ("APOLLO optimizer importable", check_apollo),
        ("nvidia-smi VRAM >=140 GB (HBM3e)", check_nvidia_smi_vram),
        ("BF16 supported", check_bf16),
    ]

    results = []
    for label, fn in checks:
        results.append(_check(label, fn))

    print("=" * 40)
    passed = sum(results)
    total = len(results)
    if passed == total:
        print(f"ALL PASS ({passed}/{total})")
        return 0
    else:
        failed = total - passed
        print(f"FAILED {failed}/{total} — fix before running distillation jobs")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
