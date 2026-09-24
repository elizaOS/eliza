"""Root-only artifact persistence qualification on the disposable VM root disk."""
import ctypes
import errno
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import time


class StoreIdentity(ctypes.Structure):
    _fields_ = [("filesystem_device", ctypes.c_uint64), ("directory_inode", ctypes.c_uint64)]


class StoreResult(ctypes.Structure):
    _fields_ = [("error", ctypes.c_int), ("create_attempted", ctypes.c_int),
                ("created", ctypes.c_int), ("file_synced", ctypes.c_int),
                ("directory_synced", ctypes.c_int), ("verified", ctypes.c_int),
                ("bytes_written", ctypes.c_uint64)]


Check = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
Progress = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int)


class Control(ctypes.Structure):
    _fields_ = [("context", ctypes.c_void_p), ("check", Check), ("progress", Progress)]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def qualify_store(library, artifact, large_artifact, binding, target_fd, target_identity, identity):
    save = library.elizaos_install_store_gpt_artifact
    save.argtypes = [ctypes.c_int, ctypes.POINTER(StoreIdentity), ctypes.c_void_p,
                     ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                     ctypes.POINTER(Control), ctypes.POINTER(StoreResult)]
    save.restype = ctypes.c_int
    read = library.elizaos_install_read_gpt_artifact
    read.argtypes = [ctypes.c_int, ctypes.POINTER(StoreIdentity), ctypes.c_void_p,
                     ctypes.c_void_p, ctypes.POINTER(Control), ctypes.c_void_p,
                     ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    read.restype = ctypes.c_int
    storage_fd = os.open("/dev/vda", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    storage_partition = os.open("/dev/vda1", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    backing = library.elizaos_install_check_recovery_storage
    backing.argtypes = [ctypes.c_int, ctypes.POINTER(StoreIdentity), ctypes.c_int, ctypes.c_int,
                        ctypes.POINTER(type(target_identity)), ctypes.c_int,
                        ctypes.POINTER(type(target_identity))]
    backing.restype = ctypes.c_int
    storage_identity = identity(storage_fd)
    storage_device = os.fstat(storage_fd).st_rdev
    target_device = os.fstat(target_fd).st_rdev
    require(subprocess.check_output(["/usr/bin/findmnt", "-n", "-o", "FSTYPE", "/"],
                                   text=True, timeout=10).strip() == "ext4", "ext4 fixture required")
    filesystem_device = os.stat("/").st_dev
    require(filesystem_device == os.stat("/dev/vda1").st_rdev and
            os.fstat(storage_fd).st_rdev != os.fstat(target_fd).st_rdev,
            "storage fixture is not the separate VM root disk")
    number = 0

    class Case:
        def __init__(self, parent=Path("/root")):
            nonlocal number
            number += 1
            self.path = parent / f"gpt-store-{number}"
            self.path.mkdir(mode=0o700)
            self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            self.id = StoreIdentity(os.fstat(self.fd).st_dev, os.fstat(self.fd).st_ino)

        def name(self, data=artifact):
            return self.path / (hashlib.sha256(data).hexdigest() + ".gpt")

        def close(self):
            os.close(self.fd)

        def guard(self):
            if (bytes(identity(storage_fd)) != bytes(storage_identity) or
                    bytes(identity(target_fd)) != bytes(target_identity) or
                    os.fstat(self.fd).st_dev != filesystem_device or
                    os.stat(self.path, follow_symlinks=False).st_ino != self.id.directory_inode):
                return -errno.ESTALE
            return backing(self.fd, ctypes.byref(self.id), storage_partition, storage_fd,
                           ctypes.byref(storage_identity), target_fd, ctypes.byref(target_identity))

        def invoke(self, storing, data=artifact, check=None, observer=None, test_identity=None,
                   source=None, expected_digest=None, capacity=None):
            events, errors = [], []
            @Check
            def checked(_context):
                try:
                    return check() if check else self.guard()
                except Exception as error:
                    errors.append(str(error))
                    return -errno.EIO
            @Progress
            def progress(_context, step):
                events.append(step)
                try:
                    if observer:
                        observer(step)
                except Exception as error:
                    errors.append(str(error))
            control = Control(None, checked, progress)
            digest = expected_digest or hashlib.sha256(data).digest()
            if storing:
                result = StoreResult()
                rc = save(self.fd, ctypes.byref(test_identity or self.id), binding,
                          data if source is None else source, len(data), digest,
                          ctypes.byref(control), ctypes.byref(result))
                require(rc == result.error, "store result disagrees with return value")
            else:
                limit = len(data) + 4096 if capacity is None else capacity
                output = ctypes.create_string_buffer(max(limit, 1))
                length = ctypes.c_size_t(123)
                rc = read(self.fd, ctypes.byref(test_identity or self.id), binding, digest,
                          ctypes.byref(control), output, limit, ctypes.byref(length))
                require(rc == 0 or length.value == 0, "failed store read advertised usable bytes")
                result = output.raw[:length.value]
            require(not errors, f"storage guard/observer failed: {errors}")
            return rc, result, events

    def wait_child(child, expected):
        deadline = time.monotonic() + 5
        while True:
            done, status = os.waitpid(child, os.WNOHANG)
            if done:
                require(os.WIFEXITED(status) and os.WEXITSTATUS(status) == expected, "storage child failed")
                return
            if time.monotonic() >= deadline:
                os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)
                raise RuntimeError("storage child blocked")
            time.sleep(0.02)

    case = Case()
    rc, result, events = case.invoke(True)
    require(rc == 0 and result.verified and result.file_synced and result.directory_synced and
            result.bytes_written == len(artifact) and events == list(range(5)), "native store did not complete")
    require(case.name().read_bytes() == artifact and case.name().stat().st_mode & 0o7777 == 0o600,
            "stored bytes or permissions differ")
    rc, value, _ = case.invoke(False)
    require(rc == 0 and value == artifact, "stored artifact could not be reopened")
    rc, result, _ = case.invoke(True)
    require(rc == -errno.EEXIST and result.create_attempted and not result.created and not result.verified,
            "store overwrote an existing artifact")
    rc, _, _ = case.invoke(False, capacity=1)
    require(rc == -errno.ENOBUFS, "small output was accepted")
    case.close()
    case = Case()
    require(case.guard() == 0, "native storage ancestry did not verify VM root")
    backing_refusals = []
    canary = os.open("/dev/vdc", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    canary_identity = identity(canary)
    for fault in ["same-target", "wrong-parent", "wrong-partition", "stale-storage", "stale-target", "directory-identity"]:
        store_fd, store_id = storage_fd, type(storage_identity).from_buffer_copy(storage_identity)
        other_fd, other_id = target_fd, type(target_identity).from_buffer_copy(target_identity)
        part_fd = storage_partition
        directory_id = StoreIdentity.from_buffer_copy(case.id)
        if fault == "same-target": other_fd, other_id = storage_fd, storage_identity
        if fault == "wrong-parent": store_fd, store_id = canary, canary_identity
        if fault == "wrong-partition": part_fd = canary
        if fault == "stale-storage": store_id.diskseq += 1
        if fault == "stale-target": other_id.diskseq += 1
        if fault == "directory-identity": directory_id.directory_inode += 1
        rc = backing(case.fd, ctypes.byref(directory_id), part_fd, store_fd,
                     ctypes.byref(store_id), other_fd, ctypes.byref(other_id))
        require(rc < 0, f"unsafe storage ancestry accepted: {fault}")
        backing_refusals.append(fault)
    os.close(canary)
    case.close()
    # A real mounted loop partition must not masquerade as independent media.
    loop_image = Path("/root/gpt-loop-storage.raw")
    with loop_image.open("xb") as stream:
        stream.truncate(160 * 1024 * 1024)
    subprocess.run(["sfdisk", str(loop_image)], input="label: gpt\nstart=2048, size=262144, type=L\n",
                   text=True, check=True, capture_output=True, timeout=15)
    subprocess.run(["modprobe", "loop"], check=True, timeout=15)
    loop = subprocess.check_output(["losetup", "--find", "--show", "--partscan", str(loop_image)],
                                   text=True, timeout=15).strip()
    require(loop.startswith("/dev/loop") and loop[9:].isdigit(), "unexpected loop fixture device")
    mounted = False
    loop_fd = loop_partition = directory_fd = None
    mountpoint = Path("/root/gpt-loop-mount")
    mountpoint.mkdir(mode=0o700)
    try:
        partition_path = Path(loop + "p1")
        deadline = time.monotonic() + 5
        while not partition_path.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        require(partition_path.exists(), "loop partition did not appear")
        subprocess.run(["mkfs.ext4", "-q", "-F", str(partition_path)], check=True, timeout=30)
        subprocess.run(["mount", "-o", "nodev,nosuid,noexec", str(partition_path), str(mountpoint)],
                       check=True, timeout=15)
        mounted = True
        mountpoint.chmod(0o700)
        loop_fd = os.open(loop, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        loop_partition = os.open(partition_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        directory_fd = os.open(mountpoint, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        loop_id = identity(loop_fd)
        loop_directory = StoreIdentity(os.fstat(directory_fd).st_dev, os.fstat(directory_fd).st_ino)
        # Establish that the otherwise valid whole-device identity is not the refusal reason.
        whole_check = library.elizaos_install_check_whole_disk
        whole_check.argtypes = [ctypes.c_int, ctypes.POINTER(type(loop_id))]
        whole_check.restype = ctypes.c_int
        require(whole_check(loop_fd, ctypes.byref(loop_id)) == 0, "loop identity fixture is invalid")
        rc = backing(directory_fd, ctypes.byref(loop_directory), loop_partition, loop_fd,
                     ctypes.byref(loop_id), target_fd, ctypes.byref(target_identity))
        require(rc == -errno.ENOENT, "loop-backed recovery storage was not refused for missing direct device")
        backing_refusals.append("loop-backed")
    finally:
        for descriptor in [directory_fd, loop_partition, loop_fd]:
            if descriptor is not None:
                os.close(descriptor)
        if mounted:
            subprocess.run(["umount", str(mountpoint)], check=True, timeout=15)
        subprocess.run(["losetup", "--detach", loop], check=True, timeout=15)
    cancellations, interruptions = [], []
    for stop in range(4):
        for terminate in [False, True]:
            case = Case()
            cancelled = False
            def progress(step):
                nonlocal cancelled
                if step == stop:
                    if terminate:
                        os._exit(74)
                    cancelled = True
            if terminate:
                child = os.fork()
                if child == 0:
                    case.invoke(True, observer=progress)
                    os._exit(90)
                wait_child(child, 74)
            else:
                rc, result, events = case.invoke(True, observer=progress,
                    check=lambda: -errno.ECANCELED if cancelled else case.guard())
                require(rc == -errno.ECANCELED and result.created and not result.verified and
                        events == list(range(stop + 1)) and
                        result.bytes_written == (0 if stop == 0 else len(artifact)), "storage cancellation continued")
            require(case.name().exists(), "interrupted artifact was silently deleted")
            # Fresh descriptor and explicit verification, not automatic journal resume.
            case.close()
            case.fd = os.open(case.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            rc, value, _ = case.invoke(False)
            require((stop == 0 and rc == -errno.EINVAL) or
                    (stop > 0 and rc == 0 and value == artifact), "interrupted artifact recovery differs")
            rc, result, _ = case.invoke(True)
            require(rc == -errno.EEXIST and not result.verified, "interrupted artifact was replaced")
            (interruptions if terminate else cancellations).append({"after": stop, "readable": stop > 0})
            case.close()
    refusals = []
    for fault in ["digest", "authorization", "directory-mode", "directory-identity", "tmpfs"]:
        case = Case(Path("/dev/shm") if fault == "tmpfs" else Path("/root"))
        options = {}
        if fault == "digest": options["expected_digest"] = bytes(32)
        if fault == "authorization": options["check"] = lambda: -errno.EPERM
        if fault == "directory-mode": os.chmod(case.path, 0o755)
        if fault == "directory-identity":
            wrong = StoreIdentity.from_buffer_copy(case.id)
            wrong.directory_inode += 1
            options["test_identity"] = wrong
        if fault == "tmpfs": options["check"] = lambda: 0  # Exercise the native filesystem gate itself.
        rc, result, _ = case.invoke(True, **options)
        require(rc < 0 and not result.create_attempted and not case.name().exists(), f"unsafe store admitted: {fault}")
        refusals.append(fault)
        case.close()
    for fault in ["fifo", "symlink", "hardlink", "file-mode", "owner", "truncated", "corrupt"]:
        case = Case()
        path = case.name()
        if fault == "fifo": os.mkfifo(path, 0o600)
        elif fault == "symlink": path.symlink_to("missing")
        else:
            path.write_bytes(artifact)
            path.chmod(0o600)
            if fault == "hardlink": os.link(path, case.path / "second-link")
            if fault == "file-mode": path.chmod(0o644)
            if fault == "owner": os.chown(path, 65534, 0)
            if fault == "truncated": os.truncate(path, len(artifact) - 1)
            if fault == "corrupt":
                changed = bytearray(artifact); changed[-1] ^= 1; path.write_bytes(changed)
        child = os.fork()
        if child == 0:
            rc, _, _ = case.invoke(False)
            os._exit(75 if rc < 0 else 90)
        wait_child(child, 75)
        refusals.append(fault)
        case.close()
    case = Case()
    checks = 0
    def cancel_chunk():
        nonlocal checks
        checks += 1
        return -errno.ECANCELED if checks == 3 else case.guard()
    rc, result, _ = case.invoke(True, data=large_artifact, check=cancel_chunk)
    require(rc == -errno.ECANCELED and result.bytes_written == 65536 and not result.verified,
            "storage ignored cancellation between write chunks")
    case.close()
    case = Case()
    source = ctypes.create_string_buffer(artifact)
    copied_identity = StoreIdentity.from_buffer_copy(case.id)
    def mutate(step):
        if step == 0:
            ctypes.memset(source, 0, len(artifact))
            copied_identity.directory_inode += 1
    rc, result, _ = case.invoke(True, source=source, test_identity=copied_identity, observer=mutate)
    require(rc == 0 and result.verified and case.name().read_bytes() == artifact, "store did not isolate verified inputs")
    case.close()
    case = Case()
    require(case.invoke(True)[0] == 0, "replacement fixture save failed")
    checks = 0
    def replace_opened():
        nonlocal checks
        checks += 1
        if checks == 2:
            case.name().rename(case.path / "old-artifact")
            case.name().write_bytes(artifact)
            case.name().chmod(0o600)
        return case.guard()
    rc, _, _ = case.invoke(False, check=replace_opened)
    require(rc == -errno.ESTALE, "read accepted replacement of its opened inode")
    case.close()
    os.close(storage_partition)
    os.close(storage_fd)
    return {"verified": True, "cancellations": cancellations, "processInterruptions": interruptions,
            "refusals": refusals, "exclusiveCreate": True, "chunkCancellation": True,
            "kernelBackingVerified": True, "backingRefusals": backing_refusals, "copiedInputs": True, "replacementRefused": True, "filesystem": "ext4 VM root",
            "storageDevice": storage_device, "targetDevice": target_device,
            "filesystemDevice": filesystem_device,
            "limits": ["not power-loss qualification", "production storage policy and journal integration absent"]}
