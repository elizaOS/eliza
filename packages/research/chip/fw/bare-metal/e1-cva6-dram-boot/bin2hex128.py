#!/usr/bin/env python3
"""Convert a flat RV64 firmware binary into a 128-bit-per-line hex image.

The E1 AXI4 DRAM controller backs a 128-bit data bus, so its $readmemh
preload buffer holds one 16-byte beat per line.  Within a beat the lowest
byte address occupies the least-significant byte (little-endian RISC-V),
so beat value = sum(byte[i] << (8*i)) for i in 0..15.  $readmemh reads the
leftmost hex digit as the MSB, so we emit each beat as a 32-hex-digit MSB
word.

Usage: bin2hex128.py <in.bin> <out.hex128>
"""

from __future__ import annotations

import sys
from pathlib import Path

BEAT_BYTES = 16


def main() -> int:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: bin2hex128.py <in.bin> <out.hex128>\n")
        return 2
    src = Path(sys.argv[1]).read_bytes()
    # Pad to a whole number of 16-byte beats.
    if len(src) % BEAT_BYTES:
        src = src + b"\x00" * (BEAT_BYTES - (len(src) % BEAT_BYTES))
    lines = []
    for off in range(0, len(src), BEAT_BYTES):
        beat = src[off : off + BEAT_BYTES]
        # little-endian byte i -> bit 8*i
        val = int.from_bytes(beat, byteorder="little")
        lines.append(f"{val:032x}\n")
    Path(sys.argv[2]).write_text("".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
