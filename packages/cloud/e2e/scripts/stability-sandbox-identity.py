"""Reject stale UID/GID authority before a sandbox identity is created.

The isolated root process reads identity and process metadata, directory entries,
and lstat ownership only. Unknown mounts, changing mount topology, unreadable
metadata, and the elapsed deadline reject admission without creating an account.
The owning launcher must serialize its admissions and exclude noncooperating
privileged filesystem/account mutations during inspection and allocation. A
metadata scan is not a snapshot against another privileged writer.
"""

import grp
import hashlib
import json
import os
import pathlib
import pwd
import re
import signal
import stat
import sys
import time

DATA_FILESYSTEMS = frozenset({"ext4", "ext3", "ext2", "xfs", "btrfs", "overlay", "tmpfs", "devtmpfs", "devpts", "vfat", "iso9660", "hugetlbfs", "mqueue", "bpf"})
KERNEL_FILESYSTEMS = frozenset({"proc", "sysfs", "cgroup2", "securityfs", "efivarfs", "pstore", "debugfs", "tracefs", "configfs", "fusectl", "binfmt_misc", "autofs"})


def decode_mount_path(value):
    decoded = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)
    path = pathlib.PurePosixPath(decoded)
    if not path.is_absolute() or ".." in path.parts or "\0" in decoded:
        raise RuntimeError("mount inventory contains an invalid path")
    return str(path)


def parse_mounts(text):
    records = []
    data_paths = set()
    for line in text.splitlines():
        left, right = line.split(" - ", 1)
        fields, details = left.split(), right.split()
        target = decode_mount_path(fields[4])
        kind = details[0]
        if kind in KERNEL_FILESYSTEMS:
            # Kernel namespaces have their own process checks; arbitrary mounts
            # using these types outside the canonical kernel trees are rejected.
            if not (target in ("/proc", "/sys") or target.startswith(("/proc/", "/sys/"))):
                raise RuntimeError("kernel mount is outside its supported hierarchy")
            data = False
        elif kind in DATA_FILESYSTEMS:
            if target in data_paths:
                raise RuntimeError("overlapping data mount targets are unsupported")
            data_paths.add(target)
            data = True
        else:
            raise RuntimeError("uninspectable filesystem type in identity admission")
        records.append({"id": int(fields[0]), "target": target, "type": kind, "data": data})
    if "/" not in data_paths:
        raise RuntimeError("root data mount is absent from identity admission")
    return records


def assert_identity_absent(uid, gid):
    try:
        pwd.getpwuid(uid)
    except KeyError:
        # error-policy:J3 Absence is the required new-identity state.
        pass
    else:
        raise RuntimeError("candidate UID already has an account")
    if any(account.pw_gid == gid for account in pwd.getpwall()):
        raise RuntimeError("candidate GID remains an account primary group")
    try:
        grp.getgrgid(gid)
    except KeyError:
        # error-policy:J3 Absence is the required new-group state.
        pass
    else:
        raise RuntimeError("candidate GID already has a group")


def assert_processes_absent(uid, gid):
    inspected = 0
    for item in pathlib.Path("/proc").iterdir():
        if not item.name.isdecimal():
            continue
        try:
            status = (item / "status").read_text()
        except FileNotFoundError:
            # error-policy:J3 A process which exited owns no remaining process authority.
            continue
        for line in status.splitlines():
            name, _, value = line.partition(":")
            if name == "Uid" and uid in map(int, value.split()):
                raise RuntimeError("candidate UID already owns a process credential")
            if name in ("Gid", "Groups") and gid in map(int, value.split()):
                raise RuntimeError("candidate GID already owns a process credential")
        inspected += 1
    return inspected


def scan_ownership(records, uid, gid):
    mount_targets = {item["target"] for item in records}
    inspected = 0

    def inspect_metadata(info):
        nonlocal inspected
        inspected += 1
        if info.st_uid == uid or info.st_gid == gid:
            raise RuntimeError("candidate identity retains filesystem ownership")

    def walk(directory_fd, path):
        initial = os.fstat(directory_fd)
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                child_path = os.path.join(path, entry.name)
                if child_path in mount_targets:
                    continue
                info = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                inspect_metadata(info)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                    try:
                        opened = os.fstat(child)
                        inspect_metadata(opened)
                        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            raise RuntimeError("directory identity changed during metadata inspection")
                        walk(child, child_path)
                    finally:
                        os.close(child)
        final = os.fstat(directory_fd)
        if (initial.st_mtime_ns, initial.st_ctime_ns) != (final.st_mtime_ns, final.st_ctime_ns):
            raise RuntimeError("directory contents changed during metadata inspection")

    for mount in records:
        if not mount["data"]:
            continue
        start = mount["target"]
        info = os.lstat(start)
        inspect_metadata(info)
        if not stat.S_ISDIR(info.st_mode):
            continue
        root = os.open(start, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(root)
            inspect_metadata(opened)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise RuntimeError("mount root identity changed during metadata inspection")
            walk(root, start)
        finally:
            os.close(root)
    return inspected


def inspect_identity(uid, gid, deadline_seconds=20, require_account_absence=True):
    if os.geteuid() != 0 or not (100_000 <= uid < 2_000_000_000 and 100_000 <= gid < 2_000_000_000):
        raise RuntimeError("identity inspection requires root and an explicit high UID/GID")
    def expired(_signal, _frame):
        raise TimeoutError("identity metadata admission deadline expired")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, deadline_seconds)
    started = time.monotonic()
    try:
        before = pathlib.Path("/proc/self/mountinfo").read_bytes()
        records = parse_mounts(before.decode())
        if require_account_absence:
            assert_identity_absent(uid, gid)
        processes = assert_processes_absent(uid, gid)
        paths = scan_ownership(records, uid, gid)
        if require_account_absence:
            assert_identity_absent(uid, gid)
        assert_processes_absent(uid, gid)
        if pathlib.Path("/proc/self/mountinfo").read_bytes() != before:
            raise RuntimeError("mount topology changed during identity inspection")
        return {"uid": uid, "gid": gid, "accountAbsenceRequired": require_account_absence, "mountInventorySha256": hashlib.sha256(before).hexdigest(), "dataMounts": sum(item["data"] for item in records), "metadataPaths": paths, "processes": processes, "elapsedSeconds": time.monotonic() - started}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


if __name__ == "__main__":
    try:
        mode = sys.argv[3] if len(sys.argv) > 3 else "admit"
        if mode not in ("admit", "owned-resource-release"):
            raise RuntimeError("unknown identity inspection mode")
        seconds = 20
        if len(sys.argv) > 4:
            seconds = float(sys.argv[4]) - time.monotonic()
            if not 0 < seconds <= 600:
                raise TimeoutError("invalid or exhausted inherited cleanup deadline")
        print(json.dumps(inspect_identity(int(sys.argv[1]), int(sys.argv[2]), deadline_seconds=seconds, require_account_absence=mode == "admit")))
    except (OSError, RuntimeError, ValueError, KeyError, IndexError) as error:
        # error-policy:J1 The privileged admission process reports rejection without creating resources.
        if isinstance(error, TimeoutError):
            diagnostic = {"code": "STABILITY_IDENTITY_DEADLINE", "reason": "identity metadata admission deadline expired"}
        elif isinstance(error, OSError):
            diagnostic = {"code": "STABILITY_IDENTITY_METADATA_UNAVAILABLE", "reason": "filesystem or process metadata was unavailable", "errno": error.errno}
        elif isinstance(error, RuntimeError):
            diagnostic = {"code": "STABILITY_IDENTITY_REJECTED", "reason": str(error)}
        else:
            diagnostic = {"code": "STABILITY_IDENTITY_METADATA_UNAVAILABLE", "reason": "identity metadata could not be parsed"}
        print(json.dumps(diagnostic), file=sys.stderr)
        raise SystemExit(1)
