import ctypes
from pathlib import Path
import os
from typing import Union

MOUNTFLAG_REMOUNT = 32
MOUNTFLAG_NOSYMFOLLOW = 256
MOUNTFLAG_BIND = 0x1000


class MountException(Exception):
    pass


def mount(src: Union[str, Path], dest: Union[str, Path], flags: int):
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.mount.argtypes = [
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_char_p,
        ctypes.c_ulong,
        ctypes.c_void_p,
    ]
    b_src = str(src).encode()
    b_dest = str(dest).encode()
    ret = libc.mount(
        b_src,  # source
        b_dest,  # target
        None,  # filesystemtype, empty for bind mounts
        flags,  # mountflags
        None,  # data
    )
    if ret != 0:
        error = os.strerror(ctypes.get_errno())
        msg = f"mount(2) call failed (source: {src}, target: {dest}): {error}"
        raise MountException(msg)
