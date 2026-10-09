#!/usr/bin/env python3
"""Boot an isolated writer test VM; never expose host block devices to it."""
import importlib.util
from pathlib import Path

NATIVE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("disk_vm", NATIVE.parents[1] / "scripts/linux/disposable-disk-vm.py")
disk_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk_vm)


def main():
    parser = disk_vm.argument_parser(__doc__)
    parser.add_argument("--pipeline-bundle", type=Path, required=True)
    parser.add_argument("--packaged-helper", type=Path, help="Qualify these shipped bytes instead of compiling a helper")
    args = parser.parse_args()
    sources = {f"usb-installer/native/{name}": (NATIVE / name).read_bytes() for name in (
        "linux-raw-writer.c", "build-raw-writer.sh", "qualify-raw-writer.py")}
    sources.update({f"linux/installer/native/{name}": (NATIVE.parent.parent / "linux/installer/native" / name).read_bytes()
                    for name in ("gpt-snapshot.c", "gpt-snapshot.h")})
    inputs = {"qualify-pipeline.mjs": args.pipeline_bundle}
    if args.packaged_helper:
        inputs["packaged-raw-writer"] = args.packaged_helper.resolve(strict=True)
        provision = "apt-get install -y --no-install-recommends libssl3t64 e2fsprogs fdisk python3\ninstall -Dm755 /inputs/packaged-raw-writer /usr/libexec/elizaos-linux-raw-writer"
    else:
        provision = "apt-get install -y --no-install-recommends gcc libc6-dev libssl-dev e2fsprogs fdisk python3\nbash /root/usb-installer/native/build-raw-writer.sh /usr/libexec/elizaos-linux-raw-writer"
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
""" + provision + """
sha256sum /usr/libexec/elizaos-linux-raw-writer > /evidence/writer-sha256.txt
python3 /root/usb-installer/native/qualify-raw-writer.py --disposable-vm --helper /usr/libexec/elizaos-linux-raw-writer --evidence /evidence/native.json
cp /inputs/node /root/node
chmod 0755 /root/node
/root/node --version
/root/node /inputs/qualify-pipeline.mjs
"""
    disk_vm.run(args, sources, script, ("native.json", "pipeline.json"), "ELIZAOS-RAW-QUALIFY",
                inputs)
    if args.packaged_helper:
        observed = (args.output_dir / "evidence/writer-sha256.txt").read_text().split()[0]
        if observed != disk_vm.restore_vm.file_hash(args.packaged_helper):
            raise RuntimeError("guest writer differs from the supplied packaged helper")


if __name__ == "__main__":
    main()
