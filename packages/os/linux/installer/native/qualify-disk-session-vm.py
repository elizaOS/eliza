#!/usr/bin/env python3
"""Qualify the actual Node native disk-session module on disposable VM disks."""
import importlib.util
from pathlib import Path

NATIVE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("disk_vm", NATIVE.parents[2] / "scripts/linux/disposable-disk-vm.py")
disk_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk_vm)


def main():
    parser = disk_vm.argument_parser(__doc__)
    parser.add_argument("--installer-bundle", type=Path, required=True)
    parser.set_defaults(timeout_seconds=3600)
    args = parser.parse_args()
    sources = {f"native/{name}": (NATIVE / name).read_bytes() for name in (
        "build.sh", "linux-peer-credentials.c", "linux-disk-session.c", "node-api-minimal.h",
        "gpt-snapshot.c", "gpt-snapshot.h", "gpt-artifact-store.c", "gpt-artifact-store.h",
        "partition-image.c", "partition-image.h",
        "qualification-inventory.mjs", "qualify-disk-session.mjs", "qualify-backup-adapter.mjs", "qualify-factory-producer.mjs", "qualify-prepared-operations.mjs", "native-peer-credentials.qualify.mjs")}
    script = """#!/bin/bash
set -euo pipefail
mkdir -p /evidence /inputs
mount -t 9p -o trans=virtio,version=9p2000.L evidence /evidence
mount -t 9p -o trans=virtio,version=9p2000.L,ro inputs /inputs
finish() { rc=$?; printf '{"exitCode":%d}\\n' "$rc" > /evidence/run-status.json; sync; poweroff; }
trap finish EXIT
exec > /evidence/runner.log 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends gcc libc6-dev libssl-dev fdisk e2fsprogs dosfstools mtools
cp /inputs/node /root/node
chmod 0755 /root/node
bash /root/native/build.sh /root/linux-installer.node
/root/node /root/native/native-peer-credentials.qualify.mjs /root/linux-installer.node
/root/node /root/native/qualify-disk-session.mjs /root/linux-installer.node /evidence/session.json
/root/node /root/native/qualify-backup-adapter.mjs /root/linux-installer.node /evidence/adapter.json
/root/node /root/native/qualify-factory-producer.mjs /evidence/factory-producer.json
/root/node /root/native/qualify-prepared-operations.mjs /root/linux-installer.node /evidence/factory-producer.json /evidence/prepared-operations.json
"""
    disk_vm.run(args, sources, script, ("session.json", "adapter.json", "factory-producer.json", "prepared-operations.json"), "ELIZAOS-DISK-SESSION",
                {"installer.mjs": args.installer_bundle}, (("ELIZAOS-ADAPTER-TEST", 80 * 1024 ** 3),))


if __name__ == "__main__":
    main()
