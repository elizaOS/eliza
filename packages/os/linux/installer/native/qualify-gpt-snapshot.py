#!/usr/bin/env python3
"""Native GPT recovery proof; fixture writes are confined to QEMU vdd."""
import argparse
import base64
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import time
import uuid
import zlib
from qualify_gpt_store import qualify_store

MAXIMUM = 128 + 3 * 4096 + 2 * 4194304
SIZE = 512 * 1024 * 1024
MIB = 1024 * 1024
BINDING = hashlib.sha256(b"disposable GPT snapshot qualification plan").digest()


class Identity(ctypes.Structure):
    _fields_ = [("major", ctypes.c_uint32), ("minor", ctypes.c_uint32),
                ("diskseq", ctypes.c_uint64), ("size_bytes", ctypes.c_uint64),
                ("sector_bytes", ctypes.c_uint32)]


class MapResult(ctypes.Structure):
    _fields_ = [("error", ctypes.c_int), ("reread_attempted", ctypes.c_int),
                ("verified", ctypes.c_int), ("partitions", ctypes.c_uint32)]


class RestoreResult(ctypes.Structure):
    _fields_ = [("error", ctypes.c_int), ("last_completed", ctypes.c_int),
                ("bytes_written", ctypes.c_uint64), ("write_attempted", ctypes.c_int)]


Check = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
Progress = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int)


class RestoreControl(ctypes.Structure):
    _fields_ = [("context", ctypes.c_void_p), ("check", Check), ("progress", Progress)]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(fd):
    h = hashlib.sha256()
    for offset in range(0, SIZE, MIB):
        block = os.pread(fd, MIB, offset)
        require(len(block) == MIB, "short fixture read")
        h.update(block)
    return h.hexdigest()


def identity(fd):
    st = os.fstat(fd)
    return Identity(os.major(st.st_rdev), os.minor(st.st_rdev),
                    struct.unpack("Q", fcntl.ioctl(fd, 0x80081280, bytes(8)))[0],
                    struct.unpack("Q", fcntl.ioctl(fd, 0x80081272, bytes(8)))[0],
                    struct.unpack("I", fcntl.ioctl(fd, 0x1268, bytes(4)))[0])


def fixture(sector, count=128, stride=128, moved=False, fault=None, alternate=False):
    last = SIZE // sector - 1
    span = ((count * stride + sector - 1) // sector) * sector
    first_array = 8 if moved else 2
    last_array = last - span // sector - (4 if moved else 0)
    first_usable, last_usable = first_array + span // sector, last_array - 1
    entries = bytearray(span)
    partitions = [
        (MIB // sector, 65 * MIB // sector - 1, "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", "EFI fixture"),
        (128 * MIB // sector, 256 * MIB // sector - 1, "0fc63daf-8483-4772-8e79-3d69d8477de4", "Linux fixture"),
    ]
    if alternate:
        partitions[1] = (160 * MIB // sector, 320 * MIB // sector - 1,
                         partitions[1][2], "Shifted fixture")
        partitions.append((384 * MIB // sector, 448 * MIB // sector - 1,
                           partitions[1][2], "Extra fixture"))
    for index, (start, end, kind, name) in enumerate(partitions):
        if fault == "overlap" and index == 1:
            start = MIB // sector + 8
        if fault == "outside-usable" and index == 0:
            start = first_usable - 1
        offset = index * stride
        entries[offset:offset + 16] = uuid.UUID(kind).bytes_le
        guid_index = 0 if fault == "duplicate-guid" else index
        entries[offset + 16:offset + 32] = uuid.UUID(int=guid_index + 11).bytes_le
        struct.pack_into("<QQQ", entries, offset + 32, start, end, 0)
        encoded = name.encode("utf-16-le")
        entries[offset + 56:offset + 56 + len(encoded)] = encoded
    if fault == "reserved-entry" and stride > 128:
        entries[128] = 1
    array_crc = zlib.crc32(entries[:count * stride])

    def header(current, other, array, secondary):
        h = bytearray(sector)
        struct.pack_into("<8sIIIIQQQQ16sQIII", h, 0, b"EFI PART", 0x10000, 92, 0, 0,
                         current, other, first_usable, last_usable,
                         uuid.UUID(int=99 if secondary and fault == "different-disk-guid" else 9).bytes_le,
                         array, count, stride, array_crc)
        struct.pack_into("<I", h, 16, zlib.crc32(h[:92]))
        return h

    mbr = bytearray(sector)
    mbr[:16] = b"test boot code!!"
    # Exercise a valid protective record outside the first MBR slot too.
    slot = 2 if moved else 0
    mbr[446 + slot * 16 + 4] = 0xee
    struct.pack_into("<II", mbr, 446 + slot * 16 + 8, 1, last)
    mbr[510:512] = b"\x55\xaa"
    return [(0, mbr), (sector, header(1, last, first_array, False)),
            (first_array * sector, entries), (last_array * sector, entries),
            (last * sector, header(last, 1, last_array, True))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-vm", action="store_true", required=True)
    parser.add_argument("--sector-size", type=int, choices=[512, 4096], required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0 and Path("/sys/class/dmi/id/sys_vendor").read_text().strip() == "QEMU",
            "QEMU root fixture required")
    require(Path("/sys/class/block/vdd/serial").read_text().strip() == "ELIZAOS-GPT-TEST" and
            Path("/sys/class/block/vdd/size").read_text().strip() == "1048576", "wrong GPT fixture")
    require(Path("/sys/class/block/vdc/serial").read_text().strip() == "ELIZAOS-CANARY", "wrong canary")
    root = subprocess.check_output(["/usr/bin/findmnt", "-n", "-o", "SOURCE", "/"], text=True, timeout=10)
    require(root.strip().startswith("/dev/vda"), "wrong VM root disk")
    library = ctypes.CDLL("/root/gpt-snapshot.so")
    capture = library.elizaos_install_capture_gpt
    capture.argtypes = [ctypes.c_int, ctypes.POINTER(Identity), ctypes.c_void_p, ctypes.c_void_p,
                        ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p]
    capture.restype = ctypes.c_int
    verify = library.elizaos_install_verify_gpt_snapshot
    verify.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
    verify.restype = ctypes.c_int
    restore = library.elizaos_install_restore_gpt
    restore.argtypes = [ctypes.c_int, ctypes.POINTER(Identity), ctypes.c_void_p,
                        ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                        ctypes.POINTER(RestoreControl), ctypes.POINTER(RestoreResult)]
    restore.restype = ctypes.c_int
    refresh = library.elizaos_install_refresh_gpt_map
    refresh.argtypes = restore.argtypes[:-1] + [ctypes.POINTER(MapResult)]
    refresh.restype = ctypes.c_int
    output, result_digest = ctypes.create_string_buffer(MAXIMUM), ctypes.create_string_buffer(32)
    fd = os.open("/dev/vdd", os.O_RDWR | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    canary = os.open("/dev/vdc", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    before_canary = digest(canary)
    expected = identity(fd)
    require(expected.size_bytes == SIZE and expected.sector_bytes == args.sector_size, "wrong geometry")
    cases = []

    def run_restore(artifact, check=None, observer=None, test_identity=None,
                    descriptor=None, source=None, binding=BINDING, expected_digest=None):
        steps, errors = [], []

        @Check
        def checked(_context):
            if errors:
                return -errno.EIO
            try:
                return check() if check else 0
            except Exception as error:
                errors.append(str(error))
                return -errno.EIO

        @Progress
        def progress(_context, step):
            steps.append(step)
            try:
                if observer:
                    observer(step)
            except Exception as error:
                errors.append(str(error))

        control = RestoreControl(None, checked, progress)
        result = RestoreResult()
        rc = restore(fd if descriptor is None else descriptor,
                     ctypes.byref(test_identity or expected), binding,
                     artifact if source is None else source, len(artifact),
                     expected_digest or hashlib.sha256(artifact).digest(),
                     ctypes.byref(control), ctypes.byref(result))
        require(not errors, f"restore observer/check failed: {errors}")
        require(result.error == rc, "restore result disagrees with its return value")
        return rc, result, steps

    def snapshot(want=0, test_identity=None, capacity=MAXIMUM, descriptor=None):
        length = ctypes.c_size_t(123)
        rc = capture(fd if descriptor is None else descriptor,
                     ctypes.byref(test_identity or expected), BINDING, output, capacity,
                     ctypes.byref(length), result_digest)
        require(rc == want, f"capture returned {rc}, expected {want}")
        if rc:
            require(length.value == 0, "failed capture advertised usable bytes")
            return None
        artifact = output.raw[:length.value]
        require(hashlib.sha256(artifact).digest() == result_digest.raw, "native digest differs")
        require(verify(artifact, len(artifact), BINDING, result_digest) == 0, "native snapshot verification failed")
        return artifact

    def write_regions(regions):
        for offset, data in regions:
            require(os.pwrite(fd, data, offset) == len(data), "short GPT fixture write")
        os.fsync(fd)

    layouts = []
    large_store_artifact = None
    for count, stride, moved in [(128, 128, False), (512, 256, True), (129, 128, True)]:
        regions = fixture(args.sector_size, count, stride, moved)
        write_regions(regions)
        before = digest(fd)
        artifact = snapshot()
        cursor = 128
        for _, data in regions:
            require(artifact[cursor:cursor + len(data)] == data, "snapshot changed original GPT bytes")
            cursor += len(data)
        require(cursor == len(artifact) and digest(fd) == before, "capture changed target or artifact extent")
        for offset, data in regions:
            require(os.pwrite(fd, bytes(len(data)), offset) == len(data), "short layout damage write")
        os.fsync(fd)
        chunk_cancelled = len(regions[3][1]) > 65536
        if chunk_cancelled:
            large_store_artifact = artifact
            checks = 0

            def cancel_second_chunk():
                nonlocal checks
                checks += 1
                # Initial admission, first chunk, then second chunk.
                return -errno.ECANCELED if checks >= 3 else 0

            rc, result, steps = run_restore(artifact, check=cancel_second_chunk)
            require(rc == -errno.ECANCELED and result.last_completed == 0 and
                    result.write_attempted and result.bytes_written == 65536 and steps == [0],
                    "large array ignored cancellation between chunks")
            for index, (offset, data) in enumerate(regions):
                want = data[:65536] + bytes(len(data) - 65536) if index == 3 else bytes(len(data))
                require(os.pread(fd, len(data), offset) == want, "chunk cancellation changed later bytes")
        rc, result, steps = run_restore(artifact)
        require(rc == 0 and result.last_completed == 7 and steps == list(range(8)) and
                result.bytes_written == len(artifact) - 128 and snapshot() == artifact and digest(fd) == before,
                "native restore failed layout recovery or changed other bytes")
        layouts.append({"entries": count, "entryBytes": stride, "relocatedArrays": moved,
                        "artifactBytes": len(artifact), "unchanged": True, "restored": True,
                        "chunkCancellation": chunk_cancelled})
    for fault in ["overlap", "outside-usable", "duplicate-guid", "different-disk-guid", "reserved-entry"]:
        write_regions(fixture(args.sector_size, 256, 256, True, fault))
        before = digest(fd)
        snapshot(want=-errno.EUCLEAN)
        require(digest(fd) == before, "rejected capture changed disk")
        cases.append(fault)
    regions = fixture(args.sector_size)
    write_regions(regions)
    artifact = snapshot()
    for offset, region in regions:
        changed = bytearray(region)
        changed[16 if region[:8] == b"EFI PART" else 0 if offset else 510] ^= 1
        os.pwrite(fd, changed, offset)
        os.fsync(fd)
        snapshot(want=-errno.EUCLEAN)
        os.pwrite(fd, region, offset)
        os.fsync(fd)
        cases.append(f"raw-corruption-{offset}")
    for field in ["major", "minor", "diskseq", "size_bytes", "sector_bytes"]:
        wrong = Identity.from_buffer_copy(expected)
        setattr(wrong, field, (4096 if args.sector_size == 512 else 512) if field == "sector_bytes"
                else getattr(wrong, field) + (args.sector_size if field == "size_bytes" else 1))
        snapshot(want=-errno.ESTALE, test_identity=wrong)
        cases.append(f"identity-{field}")
    snapshot(want=-errno.ENOBUFS, capacity=1)
    cases.append("small-output")
    regular = os.open("/root/gpt-regular-fixture", os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        snapshot(want=-errno.ENOTBLK, descriptor=regular)
    finally:
        os.close(regular)
    cases.append("regular-file")
    corrupted = bytearray(artifact)
    corrupted[-1] ^= 1
    require(verify(bytes(corrupted), len(corrupted), BINDING, hashlib.sha256(artifact).digest()) == -errno.EBADMSG,
            "changed artifact digest accepted")
    require(verify(artifact, len(artifact), bytes(32), hashlib.sha256(artifact).digest()) < 0,
            "wrong binding accepted")
    for malformed in [artifact[:-1], artifact + b"trailing"]:
        require(verify(malformed, len(malformed), BINDING, hashlib.sha256(malformed).digest()) < 0,
                "rehashed malformed envelope accepted")
    cases += ["artifact-digest", "artifact-binding", "truncated-envelope", "trailing-envelope"]
    fcntl.ioctl(fd, 0x125f)  # BLKRRPART, fixture only; native capture never issues it.
    subprocess.run(["/usr/bin/udevadm", "settle", "--timeout=10"], check=True, timeout=15)
    partition = os.open("/dev/vdd1", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        snapshot(want=-errno.EINVAL, descriptor=partition, test_identity=identity(partition))
    finally:
        os.close(partition)
    cases.append("partition-descriptor")
    original_digest = digest(fd)
    restore_refusals = []
    admission_cases = [
        ("digest", artifact, {"expected_digest": bytes(32)}, -errno.EBADMSG),
        ("binding", artifact, {"binding": bytes(32)}, -errno.EINVAL),
        ("truncated", artifact[:-1], {}, -errno.EINVAL),
        ("authorization", artifact, {"check": lambda: -errno.EPERM}, -errno.EPERM),
        ("invalid-check-result", artifact, {"check": lambda: 1}, -errno.EACCES),
    ]
    for field in ["diskseq", "sector_bytes"]:
        wrong = Identity.from_buffer_copy(expected)
        setattr(wrong, field, expected.diskseq + 1 if field == "diskseq" else
                (4096 if args.sector_size == 512 else 512))
        admission_cases.append((field, artifact, {"test_identity": wrong}, -errno.ESTALE))
    for name, candidate, options, want in admission_cases:
        rc, result, steps = run_restore(candidate, **options)
        require(rc == want and not result.write_attempted and result.bytes_written == 0 and
                result.last_completed == -1 and not steps, f"unsafe restore admission: {name}")
        restore_refusals.append(name)
    original_flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    for flag, name in [(os.O_APPEND, "append-descriptor"), (os.O_DIRECT, "direct-descriptor")]:
        fcntl.fcntl(fd, fcntl.F_SETFL, original_flags | flag)
        try:
            rc, result, steps = run_restore(artifact)
            require(rc == -errno.EACCES and not result.write_attempted and not steps,
                    f"unsafe descriptor accepted: {name}")
        finally:
            fcntl.fcntl(fd, fcntl.F_SETFL, original_flags)
        restore_refusals.append(name)
    require(digest(fd) == original_digest, "refused restore modified target")

    def damage():
        for offset, region in regions:
            require(os.pwrite(fd, bytes(len(region)), offset) == len(region), "short damaged fixture write")
        os.fsync(fd)

    def restored():
        rc, result, steps = run_restore(artifact)
        require(rc == 0 and result.last_completed == 7 and result.write_attempted == 1 and
                result.bytes_written == len(artifact) - 128 and steps == list(range(8)),
                "native restore did not reach verified GPT success")
        require(snapshot() == artifact and digest(fd) == original_digest,
                "native restore changed bytes outside the original GPT or failed exact recovery")
        return result

    def partial_state(step):
        written = {3: 1, 4: 2, 2: 3, 1: 4, 0: 5}
        for index, (offset, region) in enumerate(regions):
            want = bytes(region) if written[index] <= step else bytes(len(region))
            require(os.pread(fd, len(region), offset) == want, f"unexpected partial GPT at step {step}")

    cancellations, interruptions = [], []
    for stop in range(7):
        damage()
        cancelled = False

        def cancel(step):
            nonlocal cancelled
            if step == stop:
                cancelled = True

        rc, result, steps = run_restore(artifact, observer=cancel,
                                       check=lambda: -errno.ECANCELED if cancelled else 0)
        require(rc == -errno.ECANCELED and result.last_completed == stop and
                result.write_attempted == (stop > 0) and steps == list(range(stop + 1)),
                f"cancellation continued after step {stop}")
        partial_state(stop)
        restored()
        cancellations.append({"after": stop, "error": rc, "bytesWritten": result.bytes_written,
                              "writeAttempted": bool(result.write_attempted), "recovered": True})

        damage()
        child = os.fork()
        if child == 0:
            def terminate(step):
                if step == stop:
                    os._exit(73)
            run_restore(artifact, observer=terminate)
            os._exit(90)
        _, status = os.waitpid(child, 0)
        require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == 73,
                f"child did not terminate at checkpoint {stop}")
        # Observe a process interruption, not a guest/physical power cut. Parent
        # retains the whole-device claim; syncing here makes the observed bytes explicit.
        os.fsync(fd)
        partial_state(stop)
        restored()
        interruptions.append({"after": stop, "exitStatus": 73, "recovered": True})

    damage()
    def readonly_after_array(step):
        if step == 1:
            fcntl.ioctl(fd, 0x125d, struct.pack("i", 1))  # BLKROSET, fixture only.
    try:
        rc, result, steps = run_restore(artifact, observer=readonly_after_array)
        require(rc == -errno.EROFS and result.last_completed == 1 and result.write_attempted and
                result.bytes_written == len(regions[3][1]), "read-only transition did not stop after partial write")
        partial_state(1)
    finally:
        fcntl.ioctl(fd, 0x125d, struct.pack("i", 0))
    restored()
    damage()
    mutable_source = ctypes.create_string_buffer(artifact)
    mutable_identity = Identity.from_buffer_copy(expected)
    def mutate_inputs(step):
        if step == 0:
            ctypes.memset(mutable_source, 0, len(artifact))
            mutable_identity.diskseq += 1
    rc, result, steps = run_restore(artifact, source=mutable_source, test_identity=mutable_identity,
                                   observer=mutate_inputs)
    require(rc == 0 and result.last_completed == 7 and digest(fd) == original_digest,
            "caller input changes replaced the verified native copy")
    restore_report = {"complete": True, "cancellations": cancellations, "processInterruptions": interruptions,
                      "admissionRefusals": restore_refusals, "readOnlyAfterWrite": True,
                      "copiedInputs": True, "metadataBytesWritten": result.bytes_written,
                      "limits": ["process interruption, not power loss", "raw restore does not refresh the kernel map or prove boot recovery", "not installed"]}
    def kernel_map():
        result = {}
        for child in Path("/sys/class/block/vdd").iterdir():
            if (child / "partition").is_file():
                index = int((child / "partition").read_text())
                result[index] = (int((child / "start").read_text()), int((child / "size").read_text()))
        return result

    def run_map(check=None):
        errors = []
        @Check
        def checked(_context):
            try:
                return check() if check else 0
            except Exception as error:
                errors.append(str(error))
                return -errno.EIO
        control = RestoreControl(None, checked, Progress())
        result = MapResult()
        rc = refresh(fd, ctypes.byref(expected), BINDING, artifact, len(artifact),
                     hashlib.sha256(artifact).digest(), ctypes.byref(control), ctypes.byref(result))
        require(not errors and rc == result.error, f"map guard/result failure: {errors}")
        return rc, result

    def settle():
        subprocess.run(["/usr/bin/udevadm", "settle", "--timeout=10"], check=True, timeout=15)

    original_map = {1: (2048, 131072), 2: (262144, 262144)}
    alternate_map = {1: (2048, 131072), 2: (327680, 327680), 3: (786432, 131072)}
    require(kernel_map() == original_map, "initial kernel map differs")
    write_regions(fixture(args.sector_size, alternate=True))
    changed_digest = digest(fd)
    rc, result = run_map()
    require(rc == -errno.ESTALE and not result.reread_attempted and not result.verified and
            kernel_map() == original_map and digest(fd) == changed_digest,
            "different on-disk GPT admitted for original map recovery")
    fcntl.ioctl(fd, 0x125f)  # Establish a stale map, fixture only.
    settle()
    require(kernel_map() == alternate_map, "alternate kernel map missing")
    restored()
    stale_map = kernel_map()
    require(stale_map == alternate_map, "raw GPT restoration unexpectedly refreshed the kernel")
    rc, result = run_map(check=lambda: -errno.ECANCELED)
    require(rc == -errno.ECANCELED and not result.reread_attempted and not result.verified,
            "cancelled map refresh issued a reread")
    busy = os.open("/dev/vdd2", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        rc, result = run_map()
        require(rc == -errno.EBUSY and result.reread_attempted and not result.verified and
                kernel_map() == alternate_map, "busy map refresh was reported verified or retried")
    finally:
        os.close(busy)
    settle()
    rc, result = run_map(check=lambda: 0 if kernel_map() == alternate_map else -errno.ECANCELED)
    require(rc == -errno.ECANCELED and result.reread_attempted and not result.verified and
            kernel_map() == original_map, "post-reread cancellation was reported complete")
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

    def alter_map(operation, number, start=0, length=0):
        partition = KernelPartition(start=start, length=length, number=number)
        argument = PartitionOperation(operation=operation, length=ctypes.sizeof(partition),
                                      data=ctypes.cast(ctypes.pointer(partition), ctypes.c_void_p))
        deadline = time.monotonic() + 5
        while libc.ioctl(fd, 0x1269, ctypes.byref(argument)) != 0:
            error = ctypes.get_errno()
            if error != errno.EBUSY or time.monotonic() >= deadline:
                raise OSError(error, os.strerror(error))
            time.sleep(0.05)  # Fixture-only udev race; native refresh never retries.

    mismatch_refusals, mismatch_maps = [], []
    for fault in ["missing", "shifted", "truncated", "extra"]:
        settle()
        checks = 0
        def change_after_reread():
            nonlocal checks
            checks += 1
            if checks == 3:
                # The third check follows successful BLKRRPART. Change only the
                # kernel map, keeping both GPT copies and whole-disk bytes intact.
                settle()
                if fault != "extra":
                    alter_map(2, 2)
                if fault == "shifted":
                    alter_map(1, 2, 160 * MIB, 128 * MIB)
                elif fault == "truncated":
                    alter_map(1, 2, 128 * MIB, 64 * MIB)
                elif fault == "extra":
                    alter_map(1, 3, 384 * MIB, 64 * MIB)
                settle()
            return 0
        rc, result = run_map(check=change_after_reread)
        require(rc == -errno.ESTALE and result.reread_attempted and not result.verified and
                kernel_map() != original_map and digest(fd) == original_digest,
                f"kernel-only {fault} map mismatch was accepted")
        mismatch_refusals.append(fault)
        mismatch_maps.append({"fault": fault, "error": rc, "map": kernel_map()})
    settle()
    rc, result = run_map()
    require(rc == 0 and result.reread_attempted and result.verified and result.partitions == 2 and
            kernel_map() == original_map and digest(fd) == original_digest,
            "kernel map did not recover exact original partitions without disk mutation")
    restore_report["kernelMap"] = {"verified": True, "partitions": result.partitions,
                                   "wrongDiskRefused": True, "busyRefused": True,
                                   "cancelBeforeReread": True, "cancelAfterReread": True,
                                   "staleMapRecovered": True, "diskUnchanged": True,
                                   "mismatchRefusals": mismatch_refusals, "before": stale_map,
                                   "after": kernel_map(), "mismatchMaps": mismatch_maps}
    storage_report = qualify_store(library, artifact, large_store_artifact, BINDING, fd, expected, identity)
    require(digest(fd) == original_digest, "artifact persistence modified the target disk")
    final = digest(fd)
    os.close(fd)
    fd = os.open("/dev/vdd", os.O_RDONLY | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    require(snapshot() == artifact and digest(fd) == final, "read-only descriptor capture differs")
    rc, result, steps = run_restore(artifact)
    require(rc == -errno.EACCES and not result.write_attempted and not steps, "restore accepted read-only FD")
    restore_report["admissionRefusals"].append("read-only-descriptor")
    os.close(fd)
    fd = os.open("/dev/vdd", os.O_WRONLY | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC)
    snapshot(want=-errno.EACCES)
    os.close(fd)
    cases.append("write-only")
    require(digest(canary) == before_canary, "non-target canary changed")
    os.close(canary)
    print("ELIZAOS_GPT_SNAPSHOT_REPORT " + json.dumps({
        "status": "pass", "sectorBytes": args.sector_size, "layouts": layouts, "refusals": cases,
        "restore": restore_report, "storage": storage_report,
        "targetSha256": final, "canarySha256": before_canary,
        "artifactBase64": base64.b64encode(artifact).decode(),
        "artifactSha256": hashlib.sha256(artifact).hexdigest(),
        "binding": BINDING.hex(), "binarySha256": hashlib.sha256(Path("/root/gpt-snapshot.so").read_bytes()).hexdigest(),
        "limits": ["read-only snapshot, not durable backup storage", "no production recovery or power-loss qualification", "not installed"]
    }, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
