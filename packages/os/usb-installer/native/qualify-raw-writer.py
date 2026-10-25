#!/usr/bin/env python3
"""Exercise the production writer only on a named, disposable QEMU disk."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def has_open_target(directory, target):
    try:
        descriptors = list(directory.iterdir())
    except FileNotFoundError:
        return False
    for descriptor in descriptors:
        try:
            if os.readlink(descriptor) == str(target):
                return True
        except FileNotFoundError:
            # Loader descriptors may close between listing and readlink.
            continue
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-vm", action="store_true", required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "guest root is required")
    require(Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU", "QEMU is required")
    matches = [p for p in Path("/sys/class/block").iterdir()
               if p.joinpath("serial").is_file()
               and p.joinpath("serial").read_text().strip() == "ELIZAOS-RAW-QUALIFY"]
    require(len(matches) == 1, "unique disposable raw-writer disk is required")
    block = matches[0]
    require(not block.joinpath("partition").exists(), "whole disk is required")
    size = int(block.joinpath("size").read_text()) * 512
    require(size == 128 * 1024 * 1024, "qualification disk must be exactly 128 MiB")
    major, minor = block.joinpath("dev").read_text().strip().split(":")
    sequence = block.joinpath("diskseq").read_text().strip()
    sector = block.joinpath("queue/logical_block_size").read_text().strip()
    device = Path("/dev") / block.name
    data = bytes(range(256)) * (16 * 1024 * 1024 // 256)
    command = [str(args.helper), str(device), major, minor, sequence, str(size), sector, str(len(data))]
    evidence = {"device": str(device), "kernelIdentity": f"{major}:{minor}:{sequence}:{sector}", "cases": {}}

    def run(arguments, source=data, success=False):
        result = subprocess.run(arguments, input=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        require((result.returncode == 0) == success, f"unexpected writer result: {result.returncode}: {result.stderr!r}")
        if success:
            require(result.stdout == source, "exact readback mismatch")
            require(result.stderr == b"ELIZAOS_RAW_SYNCED\n", "sync acknowledgement mismatch")
        return result

    # Identity rejection must precede the first mutation, including size/sector drift.
    initial = os.urandom(4096)
    with device.open("r+b", buffering=0) as disk:
        disk.write(initial)
        os.fsync(disk.fileno())
    for index, value, name in [(4, str(int(sequence) + 1), "diskseq"), (5, str(size + 512), "size"),
                               (6, "4096" if sector == "512" else "512", "sector")]:
        altered = command.copy()
        altered[index] = value
        run(altered)
        with device.open("rb", buffering=0) as disk:
            require(disk.read(len(initial)) == initial, f"{name} mismatch mutated disk")
        evidence["cases"][f"reject-{name}-without-mutation"] = True

    # A mounted filesystem must keep exclusive open from succeeding.
    subprocess.run(["mkfs.ext4", "-q", "-F", str(device)], check=True)
    mount = Path("/run/elizaos-raw-writer-mounted")
    mount.mkdir(exist_ok=True)
    subprocess.run(["mount", str(device), str(mount)], check=True)
    try:
        sentinel = mount / "sentinel"
        sentinel.write_bytes(initial)
        run(command)
        require(sentinel.read_bytes() == initial, "mounted disk was changed")
    finally:
        subprocess.run(["umount", str(mount)], check=True)
    evidence["cases"]["reject-mounted-disk"] = True

    subprocess.run(["sfdisk", "--wipe", "always", str(device)], input=b"label: gpt\n,64M,L\n",
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    subprocess.run(["udevadm", "settle"], check=True)
    partition = Path(str(device) + ("p1" if device.name[-1].isdigit() else "1"))
    require(partition.is_block_device(), "partition node was not created")
    subprocess.run(["mkfs.ext4", "-q", "-F", str(partition)], check=True)
    subprocess.run(["mount", str(partition), str(mount)], check=True)
    try:
        sentinel = mount / "sentinel"
        sentinel.write_bytes(initial)
        run(command)
        require(sentinel.read_bytes() == initial, "mounted child partition was changed")
    finally:
        subprocess.run(["umount", str(mount)], check=True)
    evidence["cases"]["reject-mounted-child-partition"] = True
    partition_block = Path("/sys/class/block") / partition.name
    part_command = command.copy()
    part_command[1] = str(partition)
    part_command[2:4] = partition_block.joinpath("dev").read_text().strip().split(":")
    part_command[5] = str(int(partition_block.joinpath("size").read_text()) * 512)
    with partition.open("rb", buffering=0) as disk:
        before = disk.read(4096)
    run(part_command)
    with partition.open("rb", buffering=0) as disk:
        require(disk.read(4096) == before, "partition target was mutated")
    evidence["cases"]["reject-partition-target"] = True

    # After open, replace the pathname with an unrelated regular file. The full
    # write and readback must use the original descriptor, without reopening it.
    held = device.with_name(device.name + "-retained")
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 10
        while True:
            require(child.poll() is None, "writer exited before opening target")
            fds = Path(f"/proc/{child.pid}/fd")
            if has_open_target(fds, device):
                break
            require(time.monotonic() < deadline, "writer did not retain target descriptor")
            time.sleep(0.01)
        device.rename(held)
        device.write_bytes(initial)
        stdout, stderr = child.communicate(data, timeout=60)
        require(child.returncode == 0 and stdout == data and stderr == b"ELIZAOS_RAW_SYNCED\n", "retained-descriptor write/readback failed")
        require(device.read_bytes() == initial, "replacement path was written")
        with held.open("rb", buffering=0) as disk:
            require(disk.read(len(data)) == data, "original disk content mismatch")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        if held.exists():
            device.unlink()
            held.rename(device)
    evidence["cases"]["retained-fd-through-path-replacement"] = True
    for source, name in [(data[:4096], "short-input"), (data + b"x", "excess-input")]:
        result = run(command, source=source)
        require(b"ELIZAOS_RAW_SYNCED" not in result.stderr and not result.stdout, f"{name} produced a success receipt")
        evidence["cases"][f"reject-{name}"] = True
    run(command, success=True)
    evidence.update(success=True, expandedBytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                    helperSha256=hashlib.sha256(args.helper.read_bytes()).hexdigest())
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
