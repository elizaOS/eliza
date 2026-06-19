#!/usr/bin/env python3
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINUX_IMPORT = ROOT / "sw/linux/scripts/import-linux-bsp.sh"
BUILDROOT_IMPORT = ROOT / "sw/buildroot/scripts/import-buildroot-external.sh"


LOCAL_PREREQS = (
    ROOT / "sw/linux/drivers/e1/Kconfig",
    ROOT / "sw/linux/drivers/e1/Makefile",
    ROOT / "sw/linux/drivers/e1/e1-npu.c",
    ROOT / "sw/linux/drivers/e1/e1-dma.c",
    ROOT / "sw/linux/dts/eliza-e1.dts",
    ROOT / "sw/platform/generated/e1_platform_contract.h",
    LINUX_IMPORT,
    BUILDROOT_IMPORT,
)


def main() -> int:
    errors: list[str] = []
    for path in LOCAL_PREREQS:
        if not path.is_file():
            errors.append(f"missing local BSP import prerequisite: {path.relative_to(ROOT)}")
    if errors:
        return report(errors)

    print("BSP next external import step:")
    print("  1. Provision an external Linux kernel checkout.")
    print("  2. Run: sw/linux/scripts/import-linux-bsp.sh /path/to/linux")
    print("  3. Apply the printed Kconfig/Makefile fragments in that external tree.")
    print("  4. Run: sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux kernel-build")
    print("  5. Run: sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux dtb-check")
    print()
    print("Why Linux first: Buildroot needs a kernel tree/tarball that already contains this BSP;")
    print("OpenSBI and U-Boot need a CPU-capable SoC handoff that is still blocked.")

    linux_dir = os.environ.get("LINUX_DIR")
    if linux_dir:
        result = subprocess.run(
            [str(LINUX_IMPORT), linux_dir],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        print()
        print(f"LINUX_DIR import preflight: {linux_dir}")
        print(result.stdout.rstrip())
        if result.returncode != 0:
            errors.append(f"LINUX_DIR import preflight failed with rc={result.returncode}")
    else:
        print()
        print("Optional local preflight: set LINUX_DIR=/path/to/linux and rerun this checker.")

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("BSP next import step check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
