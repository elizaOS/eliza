#!/usr/bin/env python3
"""Project the AON SRAM aperture of pmc.elf to a $readmemh image.

The output is one 32b little-endian word per line, hex-encoded without a
``0x`` prefix. Word index 0 of the file corresponds to ``--aon-origin``;
addresses outside ``[origin, origin+bytes)`` are not represented. Bytes
that fall inside a PT_LOAD segment but past its FileSiz (i.e. .bss) are
left as zero in the output, matching the SRAM init semantics of cocotb's
``$readmemh`` (the array is initialised to zero before loading).

This script is invoked from fw/pmc/Makefile and from the cocotb harness
verify/cocotb/integration/test_pmc_ibex_boots_in_soc.py via ``make
aon-hex``. It depends only on the python stdlib so it works in every
prototype environment.
"""

from __future__ import annotations

import argparse
import struct
from pathlib import Path

ELF_MAGIC = b"\x7fELF"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--elf", required=True, type=Path)
    parser.add_argument("--aon-origin", required=True, type=lambda s: int(s, 0))
    parser.add_argument("--aon-bytes", required=True, type=lambda s: int(s, 0))
    parser.add_argument("--out", required=True, type=Path)
    return parser.parse_args()


def load_elf32_segments(elf_path: Path) -> list[tuple[int, bytes]]:
    """Return a list of (paddr, bytes) for every PT_LOAD segment (ELF32LE)."""
    blob = elf_path.read_bytes()
    if blob[:4] != ELF_MAGIC:
        raise SystemExit(f"{elf_path}: not an ELF file")
    if blob[4] != 1:
        raise SystemExit(f"{elf_path}: not ELF32 (EI_CLASS={blob[4]})")
    if blob[5] != 1:
        raise SystemExit(f"{elf_path}: not little-endian (EI_DATA={blob[5]})")

    # ELF32 header offsets (little-endian).
    e_phoff = struct.unpack_from("<I", blob, 0x1C)[0]
    e_phentsize = struct.unpack_from("<H", blob, 0x2A)[0]
    e_phnum = struct.unpack_from("<H", blob, 0x2C)[0]

    segments: list[tuple[int, bytes]] = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from("<I", blob, off + 0x00)[0]
        p_offset = struct.unpack_from("<I", blob, off + 0x04)[0]
        p_paddr = struct.unpack_from("<I", blob, off + 0x0C)[0]
        p_filesz = struct.unpack_from("<I", blob, off + 0x10)[0]
        if p_type != 1:  # PT_LOAD only
            continue
        segments.append((p_paddr, blob[p_offset : p_offset + p_filesz]))
    return segments


def project_aon(segments: list[tuple[int, bytes]], origin: int, length: int) -> bytes:
    aon = bytearray(length)
    end = origin + length
    for paddr, data in segments:
        seg_start = paddr
        seg_end = paddr + len(data)
        clip_start = max(seg_start, origin)
        clip_end = min(seg_end, end)
        if clip_start >= clip_end:
            continue
        src_off = clip_start - seg_start
        dst_off = clip_start - origin
        aon[dst_off : dst_off + (clip_end - clip_start)] = data[
            src_off : src_off + (clip_end - clip_start)
        ]
    return bytes(aon)


def write_readmemh(image: bytes, out_path: Path) -> None:
    if len(image) % 4:
        raise SystemExit("AON image is not a multiple of 4 bytes")
    with out_path.open("w") as fp:
        for word_off in range(0, len(image), 4):
            word = struct.unpack_from("<I", image, word_off)[0]
            fp.write(f"{word:08x}\n")


def main() -> None:
    args = parse_args()
    segments = load_elf32_segments(args.elf)
    image = project_aon(segments, args.aon_origin, args.aon_bytes)
    write_readmemh(image, args.out)
    print(f"aon_elf_to_hex: wrote {args.out} ({len(image)} bytes, {len(image) // 4} words)")


if __name__ == "__main__":
    main()
