#!/usr/bin/env python3
"""Root helper qualification on one named emulated USB disk inside the VM."""
import argparse
import concurrent.futures
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import mmap
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import threading
import time

spec = importlib.util.spec_from_file_location(
    "fd_proof", Path(__file__).with_name("qualify-restore-fd.py"))
fd_proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fd_proof)
require, identity, digest = fd_proof.require, fd_proof.identity, fd_proof.digest
Identity = fd_proof.Identity
HELPER = Path("/usr/libexec/elizaos-restore-helper-test")
SHIM = Path("/root/linux-restore-helper-qualification.so")
STATE = Path("/run/elizaos-usb-restore")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-vm", action="store_true", required=True)
    parser.add_argument("--sector-size", choices=(512, 4096), type=int, required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, "guest root is required")
    require(Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU", "QEMU is required")
    def usb_fixture(serial):
        matches = []
        for candidate in Path("/sys/class/block").iterdir():
            if candidate.joinpath("partition").exists():
                continue
            ancestors = list(candidate.resolve().parents)
            if any((p / "serial").is_file() and (p / "serial").read_text().strip() == serial
                   for p in ancestors):
                matches.append(candidate)
        require(len(matches) == 1, f"unique named USB fixture is missing: {serial}")
        block = matches[0]
        require(block.joinpath("removable").read_text().strip() == "1", "fixture is not removable")
        require(block.joinpath("size").read_text().strip() == "1048576", "wrong fixture capacity")
        require(any(p.name.startswith("usb") for p in block.resolve().parents), "fixture is not USB")
        return block, "/dev/" + block.name

    block, device_path = usb_fixture("ELIZAOS-HELPER-TEST")
    removal_block, removal_path = usb_fixture("ELIZAOS-TXN-TEST")
    require(device_path != removal_path, "USB fixtures alias the same disk")
    require(fd_proof.command(["/usr/bin/findmnt", "-n", "-o", "SOURCE", "/"]).strip().startswith("/dev/vda"),
            "guest must use its separate OS disk")
    descriptor = os.open(device_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    expected = identity(descriptor)
    sector_bytes = struct.unpack("I", fcntl.ioctl(descriptor, 0x1268, bytes(4)))[0]
    require(sector_bytes == args.sector_size, "USB fixture logical sector size does not match the lane")
    before = digest(descriptor, expected.size_bytes)
    os.close(descriptor)
    require(not STATE.exists() and not STATE.is_symlink(), "state fixture already exists")
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    counter = 0
    cases = []

    def request(**overrides):
        nonlocal counter
        counter += 1
        fields = {"plan_id": f"{counter:032x}", "boot_id": boot_id, "device_path": device_path,
                  "expected_major": expected.major, "expected_minor": expected.minor,
                  "expected_diskseq": expected.diskseq, "expected_size_bytes": expected.size_bytes}
        fields.update(overrides)
        lines = ["ELIZAOS_USB_RESTORE_REQUEST_V1", "operation=restore"]
        lines += [f"{key}={value}" for key, value in fields.items()]
        lines += ["partition_number=1", "filesystem=exfat", "label=ELIZAOS-USB", "acknowledgement=ERASE", "END"]
        binding = hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()
        lines.insert(3, f"plan_binding={binding}")
        return fields["plan_id"], binding, ("\n".join(lines) + "\n").encode()

    grant_times = {}

    def boottime_ns():
        return time.clock_gettime_ns(time.CLOCK_BOOTTIME)

    def authorization_bytes(plan, binding=None):
        issued, expires = grant_times[plan[0]]
        return (f"ELIZAOS_RESTORE_AUTHORIZATION_V1\n{binding or plan[1]}\n"
                f"{issued}\n{expires}\n").encode()

    def authorize(plan, lifetime_ns=300_000_000_000):
        issued = boottime_ns()
        grant_times[plan[0]] = (issued, issued + lifetime_ns)
        body = authorization_bytes(plan)
        path = STATE / "authorized" / plan[0]
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            require(os.write(fd, body) == len(body), "short authorization fixture write")
            os.fsync(fd)
        finally:
            os.close(fd)
        return path

    def check(name, plan, code, unprivileged=False):
        options = {"user": 65534, "group": 65534, "extra_groups": []} if unprivileged else {}
        result = subprocess.run([str(HELPER)], input=plan[2], capture_output=True, timeout=3,
                                env={"LANG": "C", "LC_ALL": "C", "PATH": "/nonexistent"}, **options)
        response = result.stdout.decode()
        require(result.returncode != 0 and f"code={code}\n" in response and "status=ok" not in response,
                f"{name}: unexpected response {result.returncode}: {response}")
        require(len(result.stdout) < 1024 and len(result.stderr) < 1024, "unbounded helper response")
        cases.append({"case": name, "code": code, "exitStatus": result.returncode})

    plan = request()
    check("missing-state", plan, "STATE_UNAVAILABLE")
    STATE.mkdir(mode=0o700)
    (STATE / "authorized").mkdir(mode=0o700)
    (STATE / "consumed").mkdir(mode=0o700)
    check("missing-authorization", plan, "PLAN_NOT_AUTHORIZED")
    auth = authorize(plan)
    check("exact-authorization-still-disabled", plan, "NATIVE_FD_QUALIFICATION_REQUIRED")
    check("non-root", plan, "PRIVILEGE_REQUIRED", True)
    check("previous-boot", request(boot_id="00000000-0000-0000-0000-000000000001"), "BOOT_ID_MISMATCH")
    for field in ("major", "minor", "diskseq", "size_bytes"):
        wrong = request(**{f"expected_{field}": getattr(expected, field) + 1})
        authorize(wrong)
        check(f"wrong-{field}", wrong, "TARGET_IDENTITY_MISMATCH")
    os.chmod(auth, 0o644)
    check("readable-authorization", plan, "PLAN_NOT_AUTHORIZED")
    os.chmod(auth, 0o600)
    os.chown(auth, 65534, 65534)
    check("non-root-authorization-owner", plan, "PLAN_NOT_AUTHORIZED")
    os.chown(auth, 0, 0)
    saved = auth.with_name("saved-authorization")
    auth.rename(saved)
    auth.symlink_to(saved)
    check("authorization-symlink", plan, "PLAN_NOT_AUTHORIZED")
    auth.unlink()
    os.link(saved, auth)
    check("authorization-hardlink", plan, "PLAN_NOT_AUTHORIZED")
    auth.unlink()
    os.mkfifo(auth, 0o600)
    check("authorization-fifo", plan, "PLAN_NOT_AUTHORIZED")
    auth.unlink()
    auth.mkdir(mode=0o700)
    check("authorization-directory", plan, "PLAN_NOT_AUTHORIZED")
    auth.rmdir()
    saved.rename(auth)
    auth.write_bytes(authorization_bytes(plan, binding="0" * 64))
    check("wrong-binding", plan, "PLAN_NOT_AUTHORIZED")
    auth.write_bytes(authorization_bytes(plan) + b"trailing\n")
    check("trailing-authorization-bytes", plan, "PLAN_NOT_AUTHORIZED")
    auth.write_bytes(authorization_bytes(plan))
    for name, body, code in (
        ("legacy-unbounded-authorization", (plan[1] + "\n").encode(), "PLAN_NOT_AUTHORIZED"),
        ("zero-issued-time", authorization_bytes(plan).replace(str(grant_times[plan[0]][0]).encode(), b"0"), "PLAN_NOT_AUTHORIZED"),
        ("noncanonical-deadline", authorization_bytes(plan).replace(str(grant_times[plan[0]][1]).encode(), b"01"), "PLAN_NOT_AUTHORIZED"),
        ("overflow-deadline", authorization_bytes(plan).replace(str(grant_times[plan[0]][1]).encode(), b"18446744073709551616"), "PLAN_NOT_AUTHORIZED"),
    ):
        auth.write_bytes(body)
        check(name, plan, code)
    current = boottime_ns()
    valid_times = grant_times[plan[0]]
    for name, issued, expires in (
        ("expired-authorization", current - 2_000_000_000, current - 1_000_000_000),
        ("future-authorization", current + 60_000_000_000, current + 120_000_000_000),
        ("overlong-authorization", current, current + 301_000_000_000),
        ("reversed-authorization-window", current, current - 1),
    ):
        grant_times[plan[0]] = (issued, expires)
        auth.write_bytes(authorization_bytes(plan))
        check(name, plan, "PLAN_AUTHORIZATION_EXPIRED")
    grant_times[plan[0]] = valid_times
    auth.write_bytes(authorization_bytes(plan))
    for directory in (STATE, STATE / "authorized", STATE / "consumed"):
        os.chmod(directory, 0o770)
        check(f"writable-state-{directory.name}", plan, "STATE_UNAVAILABLE")
        os.chmod(directory, 0o700)
    marker = STATE / "consumed" / plan[0]
    marker.write_text("consumed\n")
    check("consumed-marker", plan, "PLAN_ALREADY_CONSUMED")
    marker.unlink()
    marker.symlink_to("/nonexistent")
    check("consumed-symlink", plan, "PLAN_ALREADY_CONSUMED")
    marker.unlink()
    marker.mkdir(mode=0o700)
    check("consumed-directory", plan, "PLAN_ALREADY_CONSUMED")
    marker.rmdir()
    alias = Path("/dev/elizaos-helper-alias")
    alias.symlink_to(device_path)
    alias_plan = request(device_path=str(alias))
    authorize(alias_plan)
    check("device-symlink", alias_plan, "TARGET_IDENTITY_MISMATCH")
    alias.unlink()
    canary = os.open("/dev/vdc", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    canary_identity = identity(canary)
    os.close(canary)
    internal = request(device_path="/dev/vdc", **{
        f"expected_{field}": getattr(canary_identity, field) for field, _ in Identity._fields_})
    authorize(internal)
    check("non-removable-disk", internal, "TARGET_IDENTITY_MISMATCH")
    require(not list((STATE / "consumed").iterdir()), "disabled helper consumed a plan")
    descriptor = os.open(device_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    after_gate = digest(descriptor, expected.size_bytes)
    os.close(descriptor)
    require(after_gate == before, "identity gate changed the USB fixture")

    library = ctypes.CDLL(str(SHIM))
    consume = library.elizaos_qualify_consume
    consume.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    consume.restype = ctypes.c_int
    race = request()
    authorize(race)
    barrier = threading.Barrier(16, timeout=5)

    def race_consume(_):
        barrier.wait()
        return consume(race[0].encode(), race[1].encode())

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as workers:
        results = list(workers.map(race_consume, range(32)))
    require(results.count(0) == 1 and results.count(1) == 31, f"single-use race failed: {results}")
    marker = STATE / "consumed" / race[0]
    metadata = marker.stat()
    require(marker.read_bytes() == b"consumed\n" and metadata.st_uid == 0 and
            stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_nlink == 1,
            "consumed marker content or metadata is invalid")

    # Kernel-only fixture changes can race udev's short-lived probe opens.
    # Retry only EBUSY on fixture ioctls, never a native transaction or a write.
    fixture_busy_retries = 0

    def fixture_ioctl(operation):
        nonlocal fixture_busy_retries
        deadline = time.monotonic() + 5
        while True:
            try:
                return operation()
            except OSError as error:
                if error.errno != errno.EBUSY or time.monotonic() >= deadline:
                    raise
                fixture_busy_retries += 1
                fd_proof.command(["/usr/bin/udevadm", "settle", "--timeout=10"])
                time.sleep(0.05)

    # All disk mutations below target only the named disposable USB.
    descriptor = os.open(device_path, os.O_RDWR | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        gpt = ctypes.CDLL("/root/restore-gpt-fd.so")
        create = gpt.elizaos_restore_create_gpt
        create.argtypes = [ctypes.c_int, ctypes.POINTER(Identity)]
        create.restype = ctypes.c_int
        require(create(descriptor, ctypes.byref(expected)) == 0, "USB fixture GPT failed")
        fixture_ioctl(lambda: fcntl.ioctl(descriptor, 0x125F))
        fd_proof.command(["/usr/bin/udevadm", "settle", "--timeout=10"])
        bind = library.elizaos_qualify_partition
        bind.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32, ctypes.c_uint32,
                         ctypes.c_uint64, ctypes.c_uint64]
        bind.restype = ctypes.c_int

        def open_partition():
            return bind(descriptor, device_path.encode(), expected.major, expected.minor,
                        expected.diskseq, expected.size_bytes)

        partition = open_partition()
        require(partition >= 0, "native partition binding rejected the correct USB partition")
        part_identity = identity(partition)
        os.close(partition)
        original = Path(device_path + "1")
        saved_node = Path("/dev/elizaos-helper-saved-partition")
        original.rename(saved_node)
        original.symlink_to(saved_node)
        require(open_partition() < 0, "native partition binding accepted a symlink")
        original.unlink()
        os.mknod(original, stat.S_IFBLK | 0o600, os.makedev(canary_identity.major, canary_identity.minor))
        require(open_partition() < 0, "native partition binding accepted a different disk")
        original.unlink()
        saved_node.rename(original)
        partition = open_partition()
        require(partition >= 0 and bytes(identity(partition)) == bytes(part_identity),
                "restored partition binding changed")
        os.close(partition)
        # Change only the kernel partition map, leaving the verified GPT bytes
        # unchanged. Parent identity and partition number must not authorize a
        # stale extent after a failed or incomplete partition-table reread.
        class KernelPartition(ctypes.Structure):
            _fields_ = [("start", ctypes.c_longlong), ("length", ctypes.c_longlong),
                        ("number", ctypes.c_int), ("devname", ctypes.c_char * 64),
                        ("volname", ctypes.c_char * 64)]

        class PartitionOperation(ctypes.Structure):
            _fields_ = [("operation", ctypes.c_int), ("flags", ctypes.c_int),
                        ("length", ctypes.c_int), ("data", ctypes.c_void_p)]

        libc = ctypes.CDLL(None, use_errno=True)
        libc.ioctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p]
        libc.ioctl.restype = ctypes.c_int

        def kernel_partition(operation, start, length):
            partition = KernelPartition(start=start, length=length, number=1)
            argument = PartitionOperation(operation=operation, length=ctypes.sizeof(partition),
                                          data=ctypes.cast(ctypes.pointer(partition), ctypes.c_void_p))
            def invoke():
                if libc.ioctl(descriptor, 0x1269, ctypes.byref(argument)) != 0:
                    error = ctypes.get_errno()
                    raise OSError(error, os.strerror(error))
            fixture_ioctl(invoke)

        geometry_digest = digest(descriptor, expected.size_bytes)
        geometry_cases = []
        for name, start, length in (
            ("shifted start", 2 * 1024**2, part_identity.size_bytes - 1024**2),
            ("truncated length", 1024**2, part_identity.size_bytes - 4 * 1024**2),
        ):
            try:
                kernel_partition(2, 0, 0)
                kernel_partition(1, start, length)
                fd_proof.command(["/usr/bin/udevadm", "settle", "--timeout=10"])
                require(int(block.joinpath(f"{block.name}1/start").read_text()) * 512 == start and
                        int(block.joinpath(f"{block.name}1/size").read_text()) * 512 == length,
                        "kernel did not apply the stale geometry fixture")
                partition = open_partition()
                if partition >= 0:
                    os.close(partition)
                require(partition < 0, f"native partition binding accepted {name}")
                geometry_cases.append(name + " refused")
            finally:
                fixture_ioctl(lambda: fcntl.ioctl(descriptor, 0x125F))
                fd_proof.command(["/usr/bin/udevadm", "settle", "--timeout=10"])
            partition = open_partition()
            require(partition >= 0 and bytes(identity(partition)) == bytes(part_identity),
                    "GPT reread did not restore the valid partition")
            os.close(partition)
        require(digest(descriptor, expected.size_bytes) == geometry_digest,
                "kernel geometry probes changed disk bytes")
        final_digest = digest(descriptor, expected.size_bytes)
    finally:
        os.close(descriptor)
    class TransactionResult(ctypes.Structure):
        _fields_ = [("outcome", ctypes.c_int), ("media", ctypes.c_int),
                    ("last_completed", ctypes.c_int), ("error", ctypes.c_int),
                    ("tool", fd_proof.ToolResult)]

    transaction_library = Path("/root/restore-transaction-qualification.so")
    transaction_module = ctypes.CDLL(str(transaction_library))
    transaction = transaction_module.elizaos_qualify_transaction
    transaction.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_int,
                            ctypes.POINTER(TransactionResult), ctypes.POINTER(ctypes.c_uint32)]
    transaction.restype = ctypes.c_int
    transaction_cases = []

    def current_digest(path=device_path, bound=expected):
        # Formatter writes use the partition address space. Read actual whole
        # device bytes with aligned O_DIRECT I/O, not a stale whole-disk cache.
        fd = os.open(path, os.O_RDONLY | os.O_DIRECT | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            require(bytes(identity(fd)) == bytes(bound), "transaction target changed identity")
            result = hashlib.sha256()
            with mmap.mmap(-1, 1024**2) as buffer:
                view = memoryview(buffer)
                try:
                    for offset in range(0, bound.size_bytes, len(buffer)):
                        count = os.preadv(fd, [view], offset)
                        require(count == len(buffer), "short direct fixture read")
                        result.update(view)
                finally:
                    view.release()
            return result.hexdigest()
        finally:
            os.close(fd)

    def execute(plan, cancel=-1):
        result = TransactionResult()
        steps = ctypes.c_uint32()
        rc = transaction(plan[2], len(plan[2]), cancel, ctypes.byref(result), ctypes.byref(steps))
        require(rc == result.error, "transaction error/result disagree")
        return rc, result, steps.value

    def replay_refused(plan):
        before_replay = current_digest()
        rc, result, steps = execute(plan)
        require(rc == -errno.EALREADY and result.outcome == 0 and steps == 0,
                "consumed transaction replay was accepted")
        require(current_digest() == before_replay, f"replay changed disk bytes for {plan[0]}: {before_replay}")

    before_unauthorized = current_digest()
    unauthorized = request()
    rc, result, steps = execute(unauthorized)
    require(rc == -errno.EPERM and result.media == 0 and steps == 0 and result.last_completed == -1,
            "candidate transaction bypassed authorization")
    require(current_digest() == before_unauthorized, "unauthorized transaction changed disk")
    wrong_generation = request(expected_diskseq=expected.diskseq + 1)
    authorize(wrong_generation)
    rc, result, steps = execute(wrong_generation)
    require(rc == -errno.ESTALE and result.media == 0 and steps == 0 and result.last_completed == -1,
            "transaction accepted the wrong kernel device generation")
    require(not (STATE / "consumed" / wrong_generation[0]).exists() and
            current_digest() == before_unauthorized, "wrong identity consumed or changed the target")
    for step in range(10):
        plan = request()
        authorize(plan)
        untouched = current_digest() if step == 0 else None
        rc, result, steps = execute(plan, step)
        require(rc == -errno.ECANCELED and result.outcome == 1 and
                result.media == (0 if step == 0 else 1) and result.last_completed == step and
                steps == (1 << (step + 1)) - 1, f"bad cancellation result at step {step}")
        marker = STATE / "consumed" / plan[0]
        require(marker.exists() == (step > 0), "cancellation marker boundary is wrong")
        if step == 0:
            require(current_digest() == untouched, "pre-consumption cancellation changed disk")
        else:
            require(marker.read_bytes() == b"consumed\n", "transaction marker is invalid")
            replay_refused(plan)
        transaction_cases.append({"cancelAfter": step, "lastCompleted": result.last_completed,
                                  "media": result.media, "error": rc})

    for tool_path, last_step in (("/usr/bin/udevadm", 4),
                                 ("/usr/libexec/elizaos-mkfs-exfat-fd", 6),
                                 ("/usr/libexec/elizaos-fsck-exfat-fd", 7)):
        tool = Path(tool_path)
        saved = tool.with_name(tool.name + ".qualification-saved")
        require(not saved.exists(), "tool fault fixture already exists")
        plan = request()
        authorize(plan)
        tool.rename(saved)
        try:
            rc, result, steps = execute(plan)
        finally:
            saved.rename(tool)
        require(rc < 0 and result.outcome == 0 and result.media == 1 and
                result.last_completed == last_step and steps == (1 << (last_step + 1)) - 1,
                f"missing fixed tool did not stop transaction: {tool_path}")
        replay_refused(plan)
        transaction_cases.append({"missingTool": tool_path, "lastCompleted": result.last_completed,
                                  "media": result.media, "error": rc, "toolOutcome": result.tool.outcome})

    plan = request()
    authorize(plan)
    rc, result, steps = execute(plan)
    require(rc == 0 and result.outcome == 2 and result.media == 2 and
            result.last_completed == 10 and steps == (1 << 11) - 1,
            "complete native transaction did not reach verified success")
    replay_refused(plan)
    filesystem = fd_proof.command(["/usr/sbin/blkid", "-p", "-o", "export", device_path + "1"])
    require("TYPE=exfat" in filesystem.splitlines() and
            "LABEL=ELIZAOS-USB" in filesystem.splitlines(), "restored exFAT label/type is invalid")
    final_digest = current_digest()
    removal_fd = os.open(removal_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        removal_identity = identity(removal_fd)
        require(struct.unpack("I", fcntl.ioctl(removal_fd, 0x1268, bytes(4)))[0] == args.sector_size,
                "transaction removal fixture sector size differs")
    finally:
        os.close(removal_fd)
    removal_plan = request(device_path=removal_path, **{
        f"expected_{field}": getattr(removal_identity, field) for field, _ in Identity._fields_})
    observer_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int)
    observer_errors = []
    removal_evidence = {}

    @observer_type
    def observe(step, whole, partition):
        if step != 6:
            return 0
        try:
            require(bytes(identity(whole)) == bytes(removal_identity), "observer received wrong whole FD")
            part = identity(partition)
            require(part.diskseq == removal_identity.diskseq, "observer received wrong partition FD")
            removal_evidence["sha256BeforeRemoval"] = current_digest(removal_path, removal_identity)
            print("ELIZAOS_RESTORE_TRANSACTION_READY_FOR_REMOVAL", flush=True)
            whole_sysfs = Path(f"/sys/dev/block/{removal_identity.major}:{removal_identity.minor}")
            part_sysfs = Path(f"/sys/dev/block/{part.major}:{part.minor}")
            deadline = time.monotonic() + 30
            while whole_sysfs.exists() or part_sysfs.exists():
                require(time.monotonic() < deadline, "transaction USB removal timed out")
                time.sleep(0.05)
            removal_evidence["sysfsRemoved"] = True
            return 0
        except Exception as error:
            observer_errors.append(str(error))
            return 1

    observed = transaction_module.elizaos_qualify_transaction_observed
    observed.argtypes = [ctypes.c_char_p, ctypes.c_size_t, observer_type,
                         ctypes.POINTER(TransactionResult), ctypes.POINTER(ctypes.c_uint32)]
    observed.restype = ctypes.c_int
    revocation_cases = []
    for revoke_kind in ("unlink", "replace", "extend", "binding", "mode", "rename", "symlink"):
        for revoke_step in (0, 1):
            revoke_plan = request()
            before_revoke = current_digest()
            revoke_path = authorize(revoke_plan)
            revoke_errors = []
            before_fds = len(os.listdir("/proc/self/fd"))

            @observer_type
            def revoke(step, _whole, _partition):
                if step != revoke_step:
                    return 0
                try:
                    original = revoke_path.read_bytes()
                    if revoke_kind == "unlink":
                        revoke_path.unlink()
                    elif revoke_kind == "replace":
                        replacement = revoke_path.with_suffix(".replacement")
                        replacement.write_bytes(original)
                        replacement.chmod(0o600)
                        os.replace(replacement, revoke_path)
                    elif revoke_kind == "extend":
                        issued, expires = grant_times[revoke_plan[0]]
                        # Still a valid bounded grant in isolation; the admitted
                        # transaction must not adopt its changed deadline.
                        grant_times[revoke_plan[0]] = (issued + 1, expires + 1)
                        revoke_path.write_bytes(authorization_bytes(revoke_plan))
                    elif revoke_kind == "binding":
                        revoke_path.write_bytes(authorization_bytes(revoke_plan, binding="0" * 64))
                    elif revoke_kind == "mode":
                        revoke_path.chmod(0o644)
                    else:
                        moved = revoke_path.with_suffix(".withdrawn")
                        revoke_path.rename(moved)
                        if revoke_kind == "symlink":
                            revoke_path.symlink_to(moved)
                    return 0
                except Exception as error:
                    revoke_errors.append(str(error))
                    return 1

            revoke_result, revoke_steps = TransactionResult(), ctypes.c_uint32()
            revoke_rc = observed(revoke_plan[2], len(revoke_plan[2]), revoke,
                                 ctypes.byref(revoke_result), ctypes.byref(revoke_steps))
            require(not revoke_errors and revoke_rc == -errno.EKEYREVOKED and
                    revoke_result.error == revoke_rc and revoke_result.outcome == 0 and
                    revoke_result.media == revoke_step and revoke_result.last_completed == revoke_step and
                    revoke_steps.value == (1 << (revoke_step + 1)) - 1,
                    f"withdrawn transaction continued: {revoke_kind} at {revoke_step}: {revoke_errors}")
            require(len(os.listdir("/proc/self/fd")) == before_fds, "retained authorization descriptor leaked")
            require((STATE / "consumed" / revoke_plan[0]).exists() == (revoke_step == 1),
                    "revocation violated the consumption boundary")
            require(current_digest() == before_revoke, "revoked transaction wrote the target")
            revocation_cases.append({"kind": revoke_kind, "revokedAfter": revoke_step,
                                     "error": revoke_rc, "media": revoke_result.media,
                                     "diskUnchanged": True, "descriptorsClosed": True})

    expiry_cases = []
    for expiry_step in (0, 1):
        expiry_plan = request()
        before_expiry = current_digest()
        authorize(expiry_plan, lifetime_ns=5_000_000_000)
        expiry_errors = []

        @observer_type
        def expire(step, _whole, _partition):
            if step != expiry_step:
                return 0
            try:
                deadline = grant_times[expiry_plan[0]][1]
                wait_until = time.monotonic() + 6
                while boottime_ns() < deadline:
                    require(time.monotonic() < wait_until, "boot clock did not advance")
                    time.sleep(0.01)
                return 0
            except Exception as error:
                expiry_errors.append(str(error))
                return 1

        expiry_result, expiry_steps = TransactionResult(), ctypes.c_uint32()
        expiry_rc = observed(expiry_plan[2], len(expiry_plan[2]), expire,
                             ctypes.byref(expiry_result), ctypes.byref(expiry_steps))
        require(not expiry_errors and expiry_rc == -errno.EKEYEXPIRED and
                expiry_result.error == expiry_rc and expiry_result.outcome == 0 and
                expiry_result.media == expiry_step and expiry_result.last_completed == expiry_step and
                expiry_steps.value == (1 << (expiry_step + 1)) - 1,
                f"expired transaction continued at step {expiry_step}")
        require((STATE / "consumed" / expiry_plan[0]).exists() == (expiry_step == 1),
                "expiry violated the consumption boundary")
        require(current_digest() == before_expiry, "expired transaction wrote the target")
        rc, result, steps = execute(expiry_plan)
        require(rc == -errno.EKEYEXPIRED and steps == 0, "expired authorization could be reused")
        expiry_cases.append({"expiredAfter": expiry_step, "error": expiry_rc,
                             "media": expiry_result.media, "diskUnchanged": True})

    authorize(removal_plan)
    removal_result, removal_steps = TransactionResult(), ctypes.c_uint32()
    removal_rc = observed(removal_plan[2], len(removal_plan[2]), observe,
                          ctypes.byref(removal_result), ctypes.byref(removal_steps))
    require(not observer_errors, f"removal observer failed: {observer_errors}")
    require(removal_rc == -errno.ESTALE and removal_result.error == removal_rc and
            removal_result.outcome == 0 and removal_result.media == 1 and
            removal_result.last_completed == 6 and removal_steps.value == (1 << 7) - 1 and
            removal_evidence.get("sysfsRemoved"), "transaction continued or misreported after unplug")
    require((STATE / "consumed" / removal_plan[0]).read_bytes() == b"consumed\n",
            "unplugged transaction lost its consumed marker")
    rc, result, steps = execute(removal_plan)
    require(rc == -errno.EALREADY and steps == 0, "unplugged transaction replay was accepted")
    removal_evidence.update({"error": removal_rc, "lastCompleted": removal_result.last_completed,
                             "media": "incomplete", "replayRefused": True})
    require(current_digest() == final_digest, "unplug test changed the completed restore disk")
    report = {"status": "pass", "sectorBytes": sector_bytes, "cases": cases, "gateSha256Before": before,
              "gateSha256After": after_gate, "finalUsbSha256": final_digest,
              "fixtureBusyRetries": fixture_busy_retries,
              "transaction": {"cases": transaction_cases, "complete": True, "filesystem": filesystem,
                              "admissionRefusals": ["missing authorization", "wrong kernel generation"],
                              "deviceRemoval": removal_evidence, "expiry": expiry_cases,
                              "revocation": revocation_cases},
              "singleUseResults": {"accepted": results.count(0), "rejected": results.count(1)},
              "partitionBinding": ["valid partition", "symlink refused", "wrong disk refused", *geometry_cases],
              "binaries": {str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in (HELPER, SHIM, transaction_library)},
              "limits": ["emulated USB only", "no production authorization broker",
                         "no power-loss durability proof", "production helper remains disabled"]}
    print("ELIZAOS_RESTORE_HELPER_REPORT " + json.dumps(report, sort_keys=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("ELIZAOS_RESTORE_HELPER_REPORT " + json.dumps({"status": "fail", "error": str(error)}), flush=True)
        sys.exit(1)
