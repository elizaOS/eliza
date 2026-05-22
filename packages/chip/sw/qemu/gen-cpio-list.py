#!/usr/bin/env python3
"""Emit a gen_init_cpio(1) spec for an initramfs root directory.

All regular files, directories and symlinks under the given root are emitted as
root-owned (uid/gid 0) entries, plus the device nodes an initramfs needs for a
working console (/dev/console, /dev/null, /dev/ttyS0, /dev/tty). This avoids
requiring host root / mknod to assemble the cpio.
"""
import os
import stat
import sys

DEVNODES = [
    "dir /dev 0755 0 0",
    "nod /dev/console 0600 0 0 c 5 1",
    "nod /dev/null 0666 0 0 c 1 3",
    "nod /dev/ttyS0 0660 0 0 c 4 64",
    "nod /dev/tty 0666 0 0 c 5 0",
]


def main(root: str) -> int:
    for line in DEVNODES:
        print(line)
    seen = {"/", "/dev"}
    for dirpath, dirnames, filenames in os.walk(root):
        rel = "/" + os.path.relpath(dirpath, root)
        rel = "/" if rel == "/." else rel
        if rel not in seen:
            print(f"dir {rel} 0755 0 0")
            seen.add(rel)
        for name in sorted(dirnames + filenames):
            full = os.path.join(dirpath, name)
            r = "/" + os.path.relpath(full, root)
            if r == "/dev" or r.startswith("/dev/"):
                continue
            st = os.lstat(full)
            mode = stat.S_IMODE(st.st_mode)
            if stat.S_ISLNK(st.st_mode):
                print(f"slink {r} {os.readlink(full)} {mode:04o} 0 0")
            elif stat.S_ISDIR(st.st_mode):
                if r not in seen:
                    print(f"dir {r} {mode:04o} 0 0")
                    seen.add(r)
            elif stat.S_ISREG(st.st_mode):
                print(f"file {r} {full} {mode:04o} 0 0")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: gen-cpio-list.py <root-dir>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
