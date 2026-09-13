"""Admit only stdio and the verified seccomp descriptor before sandbox exec.

This trusted, isolated Python process replaces itself with the existing launch
chain. It closes inherited capabilities before the untrusted runtime can run;
the shell retains ownership of the same child PID and its cleanup resources.
The trusted launcher rejects socket stdio before this interpreter initializes.
"""

import ctypes
import errno
import fcntl
import os
import stat
import sys


def admitted_stdio(info):
    # The subprocess caller uses pipes and /dev/null; logs may be regular files.
    null_device = stat.S_ISCHR(info.st_mode) and info.st_rdev == os.makedev(1, 3)
    return stat.S_ISFIFO(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink > 0) or null_device


def main():
    if len(sys.argv) < 3:
        raise RuntimeError("descriptor admission requires a policy and command")

    admitted = {3}
    for descriptor in range(3):
        try:
            info = os.fstat(descriptor)
        except OSError as error:
            # error-policy:J3 Closed stdio is a valid absence, not a new handle.
            if error.errno != errno.EBADF:
                raise
            continue
        if stat.S_ISSOCK(info.st_mode):
            raise RuntimeError("socket-backed stdio is not admitted")
        if not admitted_stdio(info):
            raise RuntimeError("unsupported stdio descriptor kind")
        admitted.add(descriptor)

    policy = os.stat(sys.argv[1], follow_symlinks=False)
    supplied = os.fstat(3)
    if (
        not stat.S_ISREG(policy.st_mode)
        or policy.st_uid != 0
        or stat.S_IMODE(policy.st_mode) != 0o400
        or (policy.st_dev, policy.st_ino) != (supplied.st_dev, supplied.st_ino)
        or fcntl.fcntl(3, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDONLY
        or os.lseek(3, 0, os.SEEK_CUR) != 0
    ):
        raise RuntimeError("descriptor 3 is not the exact read-only policy")

    libc = ctypes.CDLL(None, use_errno=True)
    close_range = libc.close_range
    close_range.argtypes = (ctypes.c_uint, ctypes.c_uint, ctypes.c_uint)
    close_range.restype = ctypes.c_int
    # Existing descriptors can exceed a subsequently lowered RLIMIT_NOFILE.
    if close_range(4, ctypes.c_uint(-1).value, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, "closing inherited descriptors failed")

    observed = set()
    for name in os.listdir("/proc/self/fd"):
        descriptor = int(name)
        try:
            os.fstat(descriptor)
        except OSError as error:
            # error-policy:J3 In this isolated single-thread process, only listdir's
            # transient inventory descriptor closes between enumeration and fstat.
            if error.errno != errno.EBADF:
                raise
            continue
        observed.add(descriptor)
    if observed != admitted:
        raise RuntimeError("post-closure descriptor inventory is not admitted")
    os.execv(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    try:
        main()
    except (AttributeError, OSError, RuntimeError, ValueError) as error:
        # error-policy:J1 No child command is dispatched after admission fails.
        try:
            safe_diagnostic = admitted_stdio(os.fstat(2))
        except OSError:
            # error-policy:J6 Missing stderr cannot carry an admission diagnostic.
            safe_diagnostic = False
        if safe_diagnostic:
            os.write(2, f"[cloud-stability-sandbox] descriptor admission: {error}\n".encode())
        raise SystemExit(1)
