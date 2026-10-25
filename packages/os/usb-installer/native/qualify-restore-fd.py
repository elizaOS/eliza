#!/usr/bin/env python3
"""Destructive qualification, restricted to the documented disposable QEMU VM.

No host/physical disk path is accepted. Both named virtual fixtures must exist.
Run under strace to retain syscall evidence in addition to the canary digest.
"""

import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import time


class Identity(ctypes.Structure):
    _fields_ = [("major", ctypes.c_uint32), ("minor", ctypes.c_uint32),
                ("diskseq", ctypes.c_uint64), ("size_bytes", ctypes.c_uint64)]


class ToolResult(ctypes.Structure):
    _fields_ = [("outcome", ctypes.c_int), ("detail", ctypes.c_int),
                ("stdout_bytes", ctypes.c_size_t), ("stderr_bytes", ctypes.c_size_t)]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def identity(fd):
    metadata = os.fstat(fd)
    require(stat.S_ISBLK(metadata.st_mode), "fixture must be a block device")
    size = struct.unpack("Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0]
    sequence = struct.unpack("Q", fcntl.ioctl(fd, 0x80081280, bytes(8)))[0]
    return Identity(os.major(metadata.st_rdev), os.minor(metadata.st_rdev), sequence, size)


def digest(fd, size):
    result = hashlib.sha256()
    offset = 0
    while offset < size:
        block = os.pread(fd, min(1024 * 1024, size - offset), offset)
        require(bool(block), "short device read")
        result.update(block)
        offset += len(block)
    return result.hexdigest()


def command(argv, fd=None):
    # Exactly the environment and deadline intended for the native supervisor.
    result = subprocess.run(
        argv, pass_fds=() if fd is None else (fd,), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
        env={"LANG": "C", "LC_ALL": "C", "PATH": "/nonexistent"},
    )
    require(len(result.stdout) <= 256 * 1024 and len(result.stderr) <= 256 * 1024,
            "qualification child exceeded output bounds")
    require(result.returncode == 0,
            f"{argv[0]} exited {result.returncode}: {result.stderr.decode(errors='replace')}")
    return result.stdout.decode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-vm", action="store_true", required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--tools", type=Path, required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "run only inside the root-owned disposable VM")
    require(Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU",
            "qualification requires the QEMU fixture")
    for disk, serial in (("vdb", "ELIZAOS-RESTORE-TEST"),
                         ("vdc", "ELIZAOS-CANARY")):
        require(Path(f"/sys/class/block/{disk}/serial").read_text().strip() == serial,
                f"wrong {disk} fixture serial")
        require(Path(f"/sys/class/block/{disk}/size").read_text().strip() == "1048576",
                f"wrong {disk} fixture size")
    require(command(["/usr/bin/findmnt", "-n", "-o", "SOURCE", "/"]).strip().startswith("/dev/vda"),
            "the guest must boot from its separate vda OS disk")
    target = os.open("/dev/vdb", os.O_RDWR | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    canary = os.open("/dev/vdc", os.O_RDONLY | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    # Reserve FD 4 for the partition; move the read-only canary above it.
    moved = fcntl.fcntl(canary, fcntl.F_DUPFD_CLOEXEC, 10)
    os.close(canary)
    canary = moved
    partition = None
    try:
        require(target == 3, "qualification must inherit only standard FDs")
        expected = identity(target)
        canary_identity = identity(canary)
        require(expected.size_bytes == 512 * 1024 * 1024, "wrong target size")
        canary_before = digest(canary, canary_identity.size_bytes)
        before = digest(target, expected.size_bytes)
        library = ctypes.CDLL(str(args.library.resolve()))
        create = library.elizaos_restore_create_gpt
        verify = library.elizaos_restore_verify_gpt
        for function in (create, verify):
            function.argtypes = [ctypes.c_int, ctypes.POINTER(Identity)]
            function.restype = ctypes.c_int
        run_tool = library.elizaos_restore_run_tool
        run_tool.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ToolResult)]
        run_tool.restype = ctypes.c_int
        supervised = []

        def supervise(tool, fd):
            result = ToolResult()
            rc = run_tool(tool, fd, ctypes.byref(result))
            require(rc == 0 and result.outcome == 0,
                    f"native supervisor failed: {tool}, {rc}, {result.outcome}, {result.detail}")
            supervised.append({"tool": tool, "stdoutBytes": result.stdout_bytes,
                               "stderrBytes": result.stderr_bytes, "outcome": result.outcome})

        refused = []
        for field in ("major", "minor", "diskseq", "size_bytes"):
            wrong = Identity.from_buffer_copy(expected)
            setattr(wrong, field, getattr(wrong, field) + 1)
            require(create(target, ctypes.byref(wrong)) != 0, f"accepted wrong {field}")
            refused.append(field)
        require(digest(target, expected.size_bytes) == before, "identity rejection wrote target")
        readonly = os.open("/proc/self/fd/3", os.O_RDONLY | os.O_CLOEXEC)
        try:
            require(create(readonly, ctypes.byref(expected)) != 0,
                    "native creation accepted a read-only FD")
        finally:
            os.close(readonly)
        # Replace the mutable device name with a different, protected disk.
        # Retained-FD code must still succeed without opening the replacement.
        os.unlink("/dev/vdb")
        os.mknod("/dev/vdb", stat.S_IFBLK | 0o600, os.fstat(canary).st_rdev)
        require(create(target, ctypes.byref(expected)) == 0, "native GPT creation failed")
        require(verify(target, ctypes.byref(expected)) == 0, "native GPT readback failed")
        require(bytes(identity(target)) == bytes(expected), "target identity changed")
        sector = struct.unpack("I", fcntl.ioctl(target, 0x1268, bytes(4)))[0]
        corruptions = []
        for offset in (sector, expected.size_bytes - sector, 2 * sector,
                       expected.size_bytes - sector - 16384):
            original = os.pread(target, 1, offset)
            require(len(original) == 1, "short corruption fixture read")
            require(os.pwrite(target, bytes([original[0] ^ 1]), offset) == 1,
                    "short corruption fixture write")
            os.fsync(target)
            require(verify(target, ctypes.byref(expected)) != 0,
                    "accepted corrupt primary/backup GPT bytes")
            require(os.pwrite(target, original, offset) == 1, "short fixture repair")
            os.fsync(target)
            require(verify(target, ctypes.byref(expected)) == 0, "failed repaired GPT verification")
            corruptions.append(offset)
        fcntl.ioctl(target, 0x125F)  # BLKRRPART on the original held disk.
        supervise(0, -1)
        partition = os.open("/dev/vdb1", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC)
        require(partition == 4, "partition fixture must occupy FD 4")
        part_identity = identity(partition)
        part_sysfs = Path(f"/sys/dev/block/{part_identity.major}:{part_identity.minor}").resolve()
        require((part_sysfs / "partition").read_text().strip() == "1", "wrong partition")
        require((part_sysfs.parent / "dev").read_text().strip() == f"{expected.major}:{expected.minor}",
                "partition belongs to another disk")
        require(part_identity.diskseq == expected.diskseq, "wrong partition generation")
        # The primitive must reject a partition masquerading as a whole disk.
        require(create(partition, ctypes.byref(part_identity)) != 0,
                "GPT primitive accepted a partition")
        os.unlink("/dev/vdb1")
        os.mknod("/dev/vdb1", stat.S_IFBLK | 0o600, os.fstat(canary).st_rdev)
        formatter = str((args.tools / "elizaos-mkfs-exfat-fd").resolve())
        checker = str((args.tools / "elizaos-fsck-exfat-fd").resolve())
        guard_before = digest(target, expected.size_bytes)
        for tool in (formatter, checker):
            # No FD survives close_fds except standard input/output/error.
            missing = subprocess.run([tool], stdin=subprocess.DEVNULL,
                                     capture_output=True, timeout=15)
            require(missing.returncode != 0, "helper accepted a missing FD")
            override = subprocess.run([tool, "/dev/vdc"], pass_fds=(partition,),
                                      stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
            require(override.returncode == 2, "helper accepted a caller pathname")
            whole = subprocess.run(
                ["/usr/bin/python3", "-c",
                 "import os,sys; os.dup2(3,4); os.execve(sys.argv[1],[sys.argv[1]],{'LANG':'C','LC_ALL':'C','PATH':'/nonexistent'})",
                 tool], pass_fds=(target,), stdin=subprocess.DEVNULL,
                capture_output=True, timeout=15)
            require(whole.returncode != 0, "exFAT helper accepted a whole disk")
        require(digest(target, expected.size_bytes) == guard_before,
                "rejected helper invocation wrote the disk")
        for tool in (formatter, checker):
            installed = Path("/usr/libexec") / Path(tool).name
            require(installed.read_bytes() == Path(tool).read_bytes(),
                    "fixed supervisor executable differs from built helper")
        supervise(1, partition)
        supervise(2, partition)
        verification = command([checker], partition)
        require("clean" in verification, "exFAT checker did not report clean")
        os.fsync(partition)
        os.fsync(target)
        require(verify(target, ctypes.byref(expected)) == 0, "formatting damaged GPT")
        require(bytes(identity(target)) == bytes(expected), "target identity changed")
        require(bytes(identity(partition)) == bytes(part_identity), "partition identity changed")
        # The host removes the actual virtio device through QMP only after all
        # successful writes/readback have been synced. Keep both original FDs.
        whole_sysfs = Path(f"/sys/dev/block/{expected.major}:{expected.minor}")
        require(whole_sysfs.exists() and part_sysfs.exists(), "fixture disappeared early")
        print("ELIZAOS_RESTORE_READY_FOR_REMOVAL", flush=True)
        deadline = time.monotonic() + 60
        while whole_sysfs.exists() or part_sysfs.exists():
            require(time.monotonic() < deadline, "host did not remove the target device")
            time.sleep(0.05)
        removed_create = create(target, ctypes.byref(expected))
        removed_verify = verify(target, ctypes.byref(expected))
        require(removed_create < 0 and removed_verify < 0,
                "GPT primitive accepted a removed device")
        removed_tools = []
        for tool in (1, 2):
            result = ToolResult()
            rc = run_tool(tool, partition, ctypes.byref(result))
            require(rc < 0 and result.outcome == 2 and result.detail != 0,
                    "utility did not explicitly refuse the removed partition")
            removed_tools.append({"tool": tool, "rc": rc, "outcome": result.outcome,
                                  "exitStatus": result.detail})
        removal = {"sysfsRemoved": True, "gptCreateResult": removed_create,
                   "gptVerifyResult": removed_verify, "tools": removed_tools}
        canary_after = digest(canary, canary_identity.size_bytes)
        require(canary_after == canary_before, "replacement disk was modified")
        report = {
            "schema": "ai.elizaos.restore-fd-qualification.v1", "status": "pass",
            "kernel": os.uname().release, "sectorBytes": sector,
            "identity": {name: getattr(expected, name) for name, _ in Identity._fields_},
            "identityRefusals": refused, "corruptionRefusals": corruptions,
            "helperRefusals": ["missing FD", "caller pathname", "whole disk"],
            "readOnlyFdRefused": True, "deviceRemoval": removal,
            "canarySha256Before": canary_before, "canarySha256After": canary_after,
            "exfatVerification": verification, "supervisedTools": supervised,
            "binaries": {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in (args.library, Path(formatter), Path(checker))},
            "limits": ["not physical USB qualification", "not broker authorization",
                       "virtio removal is not physical USB controller qualification"],
        }
        print("ELIZAOS_RESTORE_FD_REPORT " + json.dumps(report, sort_keys=True), flush=True)
    finally:
        if partition is not None:
            os.close(partition)
        os.close(target)
        os.close(canary)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ELIZAOS_RESTORE_FD_REPORT " + json.dumps({"status": "fail", "error": str(error)}),
              flush=True)
        sys.exit(1)
