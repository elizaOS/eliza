#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Deterministic generator for the Eliza GRUB splash PNG.
#
# Renders a 1024x768 image that matches the ElizaOS visual identity:
# pure-black background, "Eliza" centered in warm orange (#FF6B35,
# the Her film + 1966 ELIZA terminal hue), a muted light-gray subtitle
# below. The PNG is written to both grub-pc/ and grub-efi/ under
# live-build/config/bootloaders/, which live-build copies to
# binary/boot/grub/splash.png at the binary stage.
#
# We shell out to ImageMagick `convert` rather than importing PIL: the
# host already has it (live-build pulls it in) and it produces the same
# bytes given the same flags + SOURCE_DATE_EPOCH for the PNG date chunk.
#
# Run with no arguments. Idempotent.

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GRUB_PC_DIR = REPO_ROOT / "live-build/config/bootloaders/grub-pc"
GRUB_EFI_DIR = REPO_ROOT / "live-build/config/bootloaders/grub-efi"

WIDTH = 1024
HEIGHT = 768
BG = "#0a0a0a"         # matches Plymouth Window.SetBackgroundTopColor
FG = "#FF6B35"         # wordmark (ElizaOS warm orange, Her/1966 vibe)
SUBFG = "#A0A0A0"      # subtitle (light gray, readable secondary tier)

WORDMARK = "Eliza"
SUBTITLE = "the operating system on this stick"


def have_convert() -> bool:
    return shutil.which("convert") is not None


def generate(out_path: Path) -> None:
    # `convert -size WxH xc:bg ...` creates a solid canvas, then we
    # layer two text labels with -gravity center + -annotate offsets.
    # -pointsize values picked to roughly match the Plymouth script
    # (Monospace 32 wordmark, Monospace 12 subtitle) scaled for 1024px.
    cmd = [
        "convert",
        "-size", f"{WIDTH}x{HEIGHT}",
        f"xc:{BG}",
        "-font", "DejaVu-Sans-Mono",
        "-gravity", "center",

        # Wordmark
        "-fill", FG,
        "-pointsize", "96",
        "-annotate", "+0-40", WORDMARK,

        # Subtitle, offset below wordmark
        "-fill", SUBFG,
        "-pointsize", "22",
        "-annotate", "+0+50", SUBTITLE,

        # Strip metadata so the PNG is reproducible from the same inputs.
        "-strip",
        "PNG24:" + str(out_path),
    ]
    subprocess.run(cmd, check=True)


def main() -> int:
    if not have_convert():
        print("error: ImageMagick `convert` not found on PATH", file=sys.stderr)
        return 1

    targets = [GRUB_PC_DIR / "splash.png", GRUB_EFI_DIR / "splash.png"]

    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)

    # Generate once, then copy — keeps both files byte-identical and
    # avoids any chance of ImageMagick producing differing output between
    # invocations.
    primary = targets[0]
    generate(primary)
    for path in targets[1:]:
        shutil.copyfile(primary, path)

    for path in targets:
        size = path.stat().st_size
        print(f"wrote {path.relative_to(REPO_ROOT)} ({size} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
