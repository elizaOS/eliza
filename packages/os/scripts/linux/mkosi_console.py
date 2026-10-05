"""Shared boot markers for VM boot and persistent-storage qualification."""

import re

GRAPHICAL_MARKERS = (
    "Linux version",
    "Started gdm.service - GNOME Display Manager",
    "Reached target Graphical Interface",
)
FORBIDDEN_MARKERS = (
    "Kernel panic - not syncing",
    "Entering emergency mode",
    "You are in emergency mode",
    "Failed to start initrd-switch-root.service",
    "VFS: Unable to mount root fs",
    "Cannot open root device",
    "No bootable device",
    "Boot failed",
    "Dependency failed for Graphical Interface",
)
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def normalized_console_text(text: str) -> str:
    """Normalize terminal escapes and systemd's old/new unit display formats."""
    text = ANSI_ESCAPE.sub("", text).replace("\r", "")
    return text.replace(
        "Reached target graphical.target - Graphical Interface",
        "Reached target Graphical Interface",
    ).replace(
        "Dependency failed for graphical.target - Graphical Interface",
        "Dependency failed for Graphical Interface",
    )
