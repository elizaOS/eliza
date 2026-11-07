"""Synthetic ZIP fixture only; no Android signature or executable code."""
import struct
import sys
import zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
    for name in ['AndroidManifest.xml', 'classes.dex', 'lib/arm64-v8a/libfixture.so']:
        entry = zipfile.ZipInfo(name)
        alignment = 16384 if name.endswith('.so') else 4
        offset = archive.fp.tell() + 30 + len(name.encode())
        padding = (-offset) % alignment
        if padding and padding < 4:
            padding += alignment
        if padding:
            entry.extra = struct.pack('<HH', 0xffff, padding - 4) + bytes(padding - 4)
        entry.compress_type = zipfile.ZIP_DEFLATED if len(sys.argv) > 2 and name.endswith(sys.argv[2]) else zipfile.ZIP_STORED
        archive.writestr(entry, b'synthetic payload')
