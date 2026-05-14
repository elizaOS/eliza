# -*- coding: utf-8 -*-

CONFIG = {
    # Minimum device size we accept as valid target for initial
    # installation, in MiB as in 1 MiB = 1024**2 bytes. I've seen USB
    # sticks labeled "8 GB" that were 7759462400 bytes = 7400 MiB
    # large, and one can probably find even smaller ones, so let's be
    # nice with users who believed what was written on the box and
    # accept slightly smaller devices than what the theory
    # would dictate.
    "min_installation_device_size": 7200,
    # Minimum device size we tell the user they should get, in MB
    # as in 1000 MB = 1 GB, i.e. let's use a unit close to what they will
    # see displayed in shops.
    "official_min_installation_device_size": 8000,
    "main_liveos_dir": "live",
    "running_liveos_mountpoint": "/lib/live/mount/medium",
    "liveos_toplevel_files": [
        "autorun.bat",
        "autorun.inf",
        "boot",
        ".disk",
        "doc",
        "EFI",
        "live",
        "isolinux",
        "syslinux",
        "tmp",
        "utils",
    ],
    "persistence": {
        "enabled": False,
    },
    "branding": {
        "distribution": "Tails",
        "header": "tails-liveusb-header.png",
        "color": "#56347c",
        "partition_label": "Tails",
    },
}
