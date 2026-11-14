"""Shared QEMU argument construction for image qualification."""

from pathlib import Path


def qemu_path_value(path: Path) -> str:
    """Keep commas literal without changing the file or UNIX socket selected."""
    return str(path.resolve()).replace(",", ",,")


def qemu_guest_arguments(architecture: str, cpu: str | None = None) -> list[str]:
    """Give virt machines a 64-bit CPU and a usable desktop framebuffer/input."""
    selected_cpu = cpu or {"arm64": "cortex-a72", "riscv64": "rv64"}.get(architecture)
    arguments = ["-cpu", selected_cpu] if selected_cpu else []
    if architecture in ("arm64", "riscv64"):
        for device in ("virtio-gpu-pci", "virtio-keyboard-pci", "virtio-tablet-pci"):
            arguments.extend(("-device", device))
    return arguments
