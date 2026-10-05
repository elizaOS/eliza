#!/usr/bin/env python3
"""Run retained-FD restore qualification on disposable Debian/QEMU disks.

Requires qemu-system-x86_64, qemu-img, genisoimage, and fdisk. The optional
container supplies only image/ISO tools; it has no privileges or host devices.
Inputs are independently digest-checked. Evidence stays outside the repository.
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import time
from pathlib import Path
import struct
import subprocess
import sys
import uuid
import zlib

IMAGE_URL = "https://cloud.debian.org/images/cloud/trixie/20260914-2601/debian-13-generic-amd64-20260914-2601.qcow2"
IMAGE_SHA512 = "a733e7d49442a03e70d03e4eb5aaf3967f3efc69ef70952f9bb10fc1ee2c4876eb95956b5ad2d31350e5fada768feb651352535fb8cd1233f61998a5a7d2e93c"
SOURCE_URL = "https://codeload.github.com/exfatprogs/exfatprogs/tar.gz/3e87676349387a119cadacd68661d2966796b7fd"
SOURCE_SHA256 = "2c342bb1a4a9fb5ace61020bb6fae1784cb48e98577b18e271691d9de85fa337"
NATIVE = Path(__file__).resolve().parent
INSTALLER_NATIVE = NATIVE.parent.parent / "linux" / "installer" / "native"
SIZE = 512 * 1024 * 1024


def file_hash(path, algorithm="sha256"):
    result = hashlib.new(algorithm)
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


def inspect_target(output, sector_size, disk="target.raw"):
    # fdisk supports explicit regular-file sector size on older hosts too;
    # sfdisk's --sector-size option is not available on Ubuntu 24.04.
    inspection = subprocess.check_output(
        ["fdisk", "-b", str(sector_size), "-l", str(output / disk)],
        text=True, timeout=15)
    (output / ("partition-map.log" if disk == "target.raw" else "helper-partition-map.log")).write_text(inspection)
    with (output / disk).open("rb") as stream:
        stream.seek(sector_size)
        header = bytearray(stream.read(sector_size))
        stored_crc = struct.unpack_from("<I", header, 16)[0]
        struct.pack_into("<I", header, 16, 0)
        if (header[:8] != b"EFI PART" or struct.unpack_from("<I", header, 12)[0] != 92
                or zlib.crc32(header[:92]) != stored_crc
                or struct.unpack_from("<II", header, 80) != (128, 128)):
            raise RuntimeError("host GPT header verification failed")
        stream.seek(struct.unpack_from("<Q", header, 72)[0] * sector_size)
        entries = stream.read(16384)
    if len(entries) != 16384 or zlib.crc32(entries) != struct.unpack_from("<I", header, 88)[0]:
        raise RuntimeError("host GPT entry checksum mismatch")
    parts = []
    for index in range(128):
        entry = entries[index * 128:(index + 1) * 128]
        if any(entry[:16]):
            start, end = struct.unpack_from("<QQ", entry, 32)
            parts.append({"number": index + 1, "start": start, "end": end,
                          "type": str(uuid.UUID(bytes_le=entry[:16])),
                          "uuid": str(uuid.UUID(bytes_le=entry[16:32])),
                          "name": entry[56:128].decode("utf-16-le").rstrip("\0")})
    if (len(parts) != 1 or parts[0]["start"] != 1024 * 1024 // sector_size
            or parts[0]["end"] != SIZE // sector_size - 16384 // sector_size - 2
            or parts[0]["type"].upper() != "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7"
            or parts[0]["name"] != "ELIZAOS"):
        raise RuntimeError("host GPT inspection failed")
    return parts


class Qmp:
    """Local VM control only. Preserve acknowledgements and asynchronous events."""

    def __init__(self, path, transcript):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(30)
        self.stream = None
        try:
            self.socket.connect(str(path))
            self.stream = self.socket.makefile("rb")
        except BaseException:
            self.socket.close()
            raise
        self.transcript = transcript
        self.messages = []
        self.sequence = 0
        try:
            if "QMP" not in self.receive():
                raise RuntimeError("missing QMP greeting")
            self.execute("qmp_capabilities")
        except BaseException:
            self.close()
            raise

    def receive(self):
        line = self.stream.readline(65537)
        if not line or len(line) > 65536:
            raise RuntimeError("missing or oversized QMP response")
        message = json.loads(line)
        if not isinstance(message, dict):
            raise RuntimeError("QMP response is not an object")
        self.messages.append(message)
        self.transcript.write(json.dumps({"received": message}) + "\n")
        self.transcript.flush()
        return message

    def execute(self, name, arguments=None):
        self.sequence += 1
        request = {"execute": name, "id": self.sequence}
        if arguments is not None:
            request["arguments"] = arguments
        self.transcript.write(json.dumps({"sent": request}) + "\n")
        self.transcript.flush()
        self.socket.sendall((json.dumps(request) + "\n").encode())
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            reply = self.receive()
            if reply.get("id") != self.sequence:
                continue
            if "error" in reply or "return" not in reply:
                raise RuntimeError(f"QMP {name} failed: {reply}")
            return reply["return"]
        raise RuntimeError(f"QMP {name} acknowledgement timed out")

    def remove_restore_device(self, device="restore-device"):
        if device not in {"restore-device", "transaction-uas"}:
            raise RuntimeError("QMP removal is restricted to named disposable targets")
        self.execute("device_del", {"id": device})
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            for message in self.messages:
                if message.get("data", {}).get("device") != device:
                    continue
                if message.get("event") == "DEVICE_UNPLUG_GUEST_ERROR":
                    raise RuntimeError("guest refused virtual device removal")
                if message.get("event") == "DEVICE_DELETED":
                    return message
            self.socket.settimeout(max(0.001, deadline - time.monotonic()))
            self.receive()
        raise RuntimeError("QMP did not confirm virtual device removal")

    def close(self):
        self.stream.close()
        self.socket.close()


def run_vm(qemu, output):
    # These are the only devices removable through this local QMP connection.
    fixtures = {
        "transaction-uas": ("ELIZAOS_RESTORE_TRANSACTION_READY_FOR_REMOVAL", "transaction-usb.raw"),
        "restore-device": ("ELIZAOS_RESTORE_READY_FOR_REMOVAL", "target.raw"),
    }
    removals = {}
    control = None
    with (output / "qemu.log").open("w") as log, (output / "qmp.log").open("w") as qmp_log:
        process = subprocess.Popen(qemu, cwd=output, stdout=log, stderr=log)
        try:
            # TCG CI reached the old 15-minute limit while still progressing
            # through the expanded GPT and USB failure-path suite.
            deadline = time.monotonic() + 1500
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise RuntimeError("qualification VM timed out")
                proof_log = output / "proof.log"
                if proof_log.exists():
                    lines = proof_log.read_text(errors="replace").splitlines()
                    for device, (marker, disk) in fixtures.items():
                        if device not in removals and marker in lines:
                            before = file_hash(output / disk)
                            if control is None:
                                control = Qmp(output / "qmp.sock", qmp_log)
                            event = control.remove_restore_device(device)
                            removals[device] = {"event": event, "targetSha256Before": before}
                time.sleep(0.1)
            if process.returncode != 0:
                raise RuntimeError(f"qualification VM exited {process.returncode}")
            lines = (output / "proof.log").read_text(errors="strict").splitlines()
            for device, (marker, disk) in fixtures.items():
                if device not in removals or lines.count(marker) != 1:
                    raise RuntimeError(f"VM did not complete exactly one removal handshake: {device}")
                after = file_hash(output / disk)
                if removals[device]["targetSha256Before"] != after:
                    raise RuntimeError(f"removed target changed during refusal checks: {device}")
                removals[device]["targetSha256After"] = after
            return removals["restore-device"], removals["transaction-uas"]
        finally:
            if control is not None:
                control.close()
            if process.poll() is None:
                process.kill()
            process.wait()


def main():
    host_runner_sha256 = file_hash(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-image", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sector-size", choices=(512, 4096), type=int, required=True)
    parser.add_argument("--accelerator", choices=("kvm", "tcg"), default="kvm")
    parser.add_argument("--container-tools-image")
    args = parser.parse_args()
    base = args.base_image.resolve(strict=True)
    source = args.source_archive.resolve(strict=True)
    output = args.output_dir.resolve()
    if file_hash(base, "sha512") != IMAGE_SHA512 or file_hash(source) != SOURCE_SHA256:
        raise RuntimeError("qualification input digest mismatch")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)

    def image_tool(argv):
        command = argv
        if args.container_tools_image:
            command = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                       "-v", f"{output}:{output}", "-v", f"{base}:{base}:ro",
                       "-w", str(output), args.container_tools_image, *argv]
        subprocess.run(command, cwd=output, check=True, timeout=60)

    sources = {name: (NATIVE / name).read_bytes() for name in (
        "restore-gpt-fd.c", "restore-gpt-fd.h", "exfatprogs-fd.patch",
        "restore-tool-runner.c", "restore-tool-runner.h", "restore-tool-runner.test.c",
        "build-exfat-fd.sh", "qualify-restore-fd.py", "qualify-restore-helper.py",
        "linux-restore-helper.c", "linux-restore-helper.qualify.c",
        "restore-transaction.c", "restore-transaction.h", "restore-transaction.qualify.c",
    )}
    installer_sources = {name: (INSTALLER_NATIVE / name).read_bytes() for name in (
        "gpt-snapshot.c", "gpt-snapshot.h", "gpt-artifact-store.c", "gpt-artifact-store.h",
        "qualify-gpt-snapshot.py", "qualify_gpt_store.py",
    )}
    data = """#cloud-config
hostname: elizaos-restore-qualification
package_update: true
packages: [gcc, make, autoconf, automake, libtool, patch, libc6-dev, libfdisk-dev, libssl-dev, fdisk, python3, strace]
write_files:
"""
    for name, content in {**sources, **installer_sources, "exfat.tar.gz": source.read_bytes()}.items():
        data += (f"  - path: /root/{name}\n    permissions: '0600'\n    encoding: b64\n"
                 f"    content: {base64.b64encode(content).decode()}\n")
    guest_script = """#!/bin/sh
set -eu
# Keep structured evidence off the kernel/getty console.
stty -F /dev/ttyS1 raw -echo 115200
bash /root/build-exfat-fd.sh /root/exfat.tar.gz /root/exfat-tools
install -m 0755 /root/exfat-tools/elizaos-mkfs-exfat-fd /root/exfat-tools/elizaos-fsck-exfat-fd /usr/libexec/
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 -shared -fPIC /root/restore-gpt-fd.c /root/restore-tool-runner.c -lfdisk -o /root/restore-gpt-fd.so
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 /root/restore-tool-runner.test.c -o /root/restore-tool-runner-test
/root/restore-tool-runner-test
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 /root/linux-restore-helper.c -o /usr/libexec/elizaos-restore-helper-test
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 -shared -fPIC /root/linux-restore-helper.qualify.c -o /root/linux-restore-helper-qualification.so
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 -shared -fPIC /root/restore-transaction.qualify.c /root/restore-transaction.c /root/restore-gpt-fd.c /root/restore-tool-runner.c -lfdisk -o /root/restore-transaction-qualification.so
cc -std=c17 -O2 -Wall -Wextra -Werror -Wconversion -Wshadow -Wformat=2 -shared -fPIC /root/gpt-snapshot.c /root/gpt-artifact-store.c -lcrypto -o /root/gpt-snapshot.so
python3 /root/qualify-gpt-snapshot.py --disposable-vm --sector-size SECTOR_BYTES > /dev/ttyS1
helper_status=0
strace -f -e trace=openat,fcntl,ioctl,fsync -o /root/helper.trace python3 /root/qualify-restore-helper.py --disposable-vm --sector-size SECTOR_BYTES > /dev/ttyS1 || helper_status=$?
cat /root/helper.trace
if [ "$helper_status" != 0 ]; then exit "$helper_status"; fi
status=0
strace -f -e trace=openat,fcntl,ioctl -o /root/restore.trace python3 /root/qualify-restore-fd.py --disposable-vm --library /root/restore-gpt-fd.so --tools /root/exfat-tools > /dev/ttyS1 || status=$?
cat /root/restore.trace
exit "$status"
"""
    guest_script = guest_script.replace("SECTOR_BYTES", str(args.sector_size))
    data += ("  - path: /root/run-qualification.sh\n    permissions: '0700'\n    encoding: b64\n"
             f"    content: {base64.b64encode(guest_script.encode()).decode()}\n")
    data += "runcmd:\n  - [sh, -c, '/root/run-qualification.sh > /dev/ttyS0 2>&1']\n  - [poweroff]\n"
    (output / "user-data").write_text(data)
    (output / "meta-data").write_text("instance-id: elizaos-restore-fd-test\n")
    image_tool(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(base),
                str(output / "guest.qcow2"), "8G"])
    image_tool(["genisoimage", "-quiet", "-output", str(output / "seed.iso"),
                "-volid", "cidata", "-joliet", "-rock", "user-data", "meta-data"])
    for disk in ("target.raw", "canary.raw", "helper-usb.raw", "transaction-usb.raw", "gpt-snapshot.raw"):
        with (output / disk).open("xb") as stream:
            stream.truncate(SIZE)
    before = file_hash(output / "canary.raw")
    qemu = ["qemu-system-x86_64", "-accel", args.accelerator,
            "-cpu", "host" if args.accelerator == "kvm" else "max",
            "-m", "2048", "-smp", "2", "-display", "none", "-monitor", "none",
            "-qmp", "unix:qmp.sock,server=on,wait=off",
            "-serial", f"file:{output / 'guest.log'}",
            "-serial", f"file:{output / 'proof.log'}", "-no-reboot", "-boot", "order=c",
            "-drive", "file=guest.qcow2,if=none,id=os,format=qcow2",
            "-device", "virtio-blk-pci,drive=os,bootindex=1",
            "-drive", "file=target.raw,if=none,id=restore,format=raw",
            "-device", ("virtio-blk-pci,id=restore-device,drive=restore,serial=ELIZAOS-RESTORE-TEST,"
                        f"logical_block_size={args.sector_size},physical_block_size={args.sector_size}"),
            "-drive", "file=canary.raw,if=none,id=canary,format=raw",
            "-device", "virtio-blk-pci,drive=canary,serial=ELIZAOS-CANARY",
            "-drive", "file=gpt-snapshot.raw,if=none,id=gpt-snapshot,format=raw",
            "-device", ("virtio-blk-pci,id=gpt-snapshot-device,drive=gpt-snapshot,serial=ELIZAOS-GPT-TEST,"
                        f"logical_block_size={args.sector_size},physical_block_size={args.sector_size}"),
            "-device", "qemu-xhci,id=helper-xhci",
            "-drive", "file=helper-usb.raw,if=none,id=helper-usb,format=raw",
            "-device", "usb-uas,id=helper-uas,bus=helper-xhci.0,serial=ELIZAOS-HELPER-TEST",
            "-device", ("scsi-hd,bus=helper-uas.0,drive=helper-usb,removable=on,"
                        "serial=ELIZAOS-HELPER-TEST,"
                        f"logical_block_size={args.sector_size},physical_block_size={args.sector_size}"),
            "-drive", "file=transaction-usb.raw,if=none,id=transaction-usb,format=raw",
            "-device", "usb-uas,id=transaction-uas,bus=helper-xhci.0,serial=ELIZAOS-TXN-TEST",
            "-device", ("scsi-hd,bus=transaction-uas.0,drive=transaction-usb,removable=on,"
                        "serial=ELIZAOS-TXN-TEST,"
                        f"logical_block_size={args.sector_size},physical_block_size={args.sector_size}"),
            "-drive", "file=seed.iso,media=cdrom,readonly=on", "-netdev", "user,id=n0",
            "-device", "virtio-net-pci,netdev=n0"]
    print(f"Booting isolated {args.sector_size}-byte sector qualification VM: {output}", flush=True)
    removal, transaction_removal = run_vm(qemu, output)
    transcript = (output / "proof.log").read_text(errors="strict")
    reports = [json.loads(line.split("ELIZAOS_RESTORE_FD_REPORT ", 1)[1])
               for line in transcript.splitlines() if line.startswith("ELIZAOS_RESTORE_FD_REPORT ")]
    if len(reports) != 1 or reports[0].get("status") != "pass":
        raise RuntimeError(f"guest did not qualify: {reports}; inspect {output / 'guest.log'}")
    snapshot_reports = [json.loads(line.split("ELIZAOS_GPT_SNAPSHOT_REPORT ", 1)[1])
                        for line in transcript.splitlines() if line.startswith("ELIZAOS_GPT_SNAPSHOT_REPORT ")]
    if len(snapshot_reports) != 1 or snapshot_reports[0].get("status") != "pass":
        raise RuntimeError("native GPT snapshot did not qualify")
    snapshot_report = snapshot_reports[0]
    if (snapshot_report["sectorBytes"] != args.sector_size or snapshot_report["canarySha256"] != before or
            snapshot_report["targetSha256"] != file_hash(output / "gpt-snapshot.raw")):
        raise RuntimeError("GPT snapshot target/canary digest mismatch")
    artifact = base64.b64decode(snapshot_report.pop("artifactBase64"), validate=True)
    if (hashlib.sha256(artifact).hexdigest() != snapshot_report["artifactSha256"] or
            artifact[:16] != b"ELIZAOS-GPT-V1\x00\x00" or len(artifact) < 128):
        raise RuntimeError("GPT snapshot artifact digest/envelope mismatch")
    sector, span, size, primary_array, secondary_array = struct.unpack_from("<IIQQQ", artifact, 16)
    if (sector != args.sector_size or span < 16384 or span > 4194304 or span % sector or size != SIZE or
            artifact[48:80].hex() != snapshot_report["binding"] or any(artifact[80:128]) or
            len(artifact) != 128 + 3 * sector + 2 * span):
        raise RuntimeError("GPT snapshot geometry mismatch")
    cursor = 128
    storage = snapshot_report["storage"]
    expected_store_stops = [{"after": step, "readable": step > 0} for step in range(4)]
    if (not all(storage.get(key) is True for key in ["verified", "exclusiveCreate", "chunkCancellation",
                                                    "copiedInputs", "replacementRefused", "kernelBackingVerified"]) or
            storage["backingRefusals"] != ["same-target", "wrong-parent", "wrong-partition", "stale-storage",
                                            "stale-target", "directory-identity", "loop-backed"] or
            storage["storageDevice"] == storage["targetDevice"] or storage["filesystem"] != "ext4 VM root" or
            storage["cancellations"] != expected_store_stops or
            storage["processInterruptions"] != expected_store_stops or
            storage["refusals"] != ["digest", "authorization", "directory-mode", "directory-identity", "tmpfs",
                                    "fifo", "symlink", "hardlink", "file-mode", "owner", "truncated", "corrupt"]):
        raise RuntimeError("native GPT artifact persistence proof incomplete")
    restoration = snapshot_report["restore"]
    original_map = {"1": [2048, 131072], "2": [262144, 262144]}
    alternate_map = {"1": [2048, 131072], "2": [327680, 327680], "3": [786432, 131072]}
    mismatches = [
        {"fault": "missing", "error": -116, "map": {"1": original_map["1"]}},
        {"fault": "shifted", "error": -116, "map": {"1": original_map["1"], "2": [327680, 262144]}},
        {"fault": "truncated", "error": -116, "map": {"1": original_map["1"], "2": [262144, 131072]}},
        {"fault": "extra", "error": -116, "map": {**original_map, "3": [786432, 131072]}},
    ]
    if restoration.get("kernelMap") != {
            "verified": True, "partitions": 2, "wrongDiskRefused": True,
            "busyRefused": True, "cancelBeforeReread": True, "cancelAfterReread": True,
            "staleMapRecovered": True, "diskUnchanged": True,
            "mismatchRefusals": ["missing", "shifted", "truncated", "extra"],
            "before": alternate_map, "after": original_map, "mismatchMaps": mismatches}:
        raise RuntimeError("native GPT kernel-map recovery proof incomplete")
    if (len(snapshot_report["layouts"]) != 3 or
            not all(layout.get("restored") for layout in snapshot_report["layouts"]) or
            not any(layout.get("chunkCancellation") for layout in snapshot_report["layouts"])):
        raise RuntimeError("native GPT layout/chunk recovery proof incomplete")
    if (restoration.get("complete") is not True or restoration.get("readOnlyAfterWrite") is not True or
            restoration.get("copiedInputs") is not True or
            restoration.get("metadataBytesWritten") != len(artifact) - 128 or
            len(set(restoration["admissionRefusals"])) != 10):
        raise RuntimeError("native GPT restoration/refusal proof incomplete")
    written_by_step = [0, span, span + sector, 2 * span + sector,
                       2 * span + 2 * sector, 2 * span + 3 * sector, 2 * span + 3 * sector]
    expected_cancellations = [{"after": step, "error": -125, "bytesWritten": written,
                               "writeAttempted": step > 0, "recovered": True}
                              for step, written in enumerate(written_by_step)]
    expected_interruptions = [{"after": step, "exitStatus": 73, "recovered": True} for step in range(7)]
    if (restoration["cancellations"] != expected_cancellations or
            restoration["processInterruptions"] != expected_interruptions):
        raise RuntimeError("native GPT interrupted recovery proof incomplete")
    with (output / "gpt-snapshot.raw").open("rb") as disk:
        for lba, length in [(0, sector), (1, sector), (primary_array, span),
                            (secondary_array, span), (SIZE // sector - 1, sector)]:
            if lba * sector + length > SIZE:
                raise RuntimeError("GPT snapshot region exceeds disk")
            disk.seek(lba * sector)
            if disk.read(length) != artifact[cursor:cursor + length]:
                raise RuntimeError("GPT snapshot did not preserve exact on-disk metadata")
            cursor += length
    (output / "gpt-snapshot.bin").write_bytes(artifact)
    (output / "gpt-snapshot-partitions.log").write_text(subprocess.check_output(
        ["fdisk", "-b", str(sector), "-l", str(output / "gpt-snapshot.raw")], text=True, timeout=15))
    helper_reports = [json.loads(line.split("ELIZAOS_RESTORE_HELPER_REPORT ", 1)[1])
                      for line in transcript.splitlines() if line.startswith("ELIZAOS_RESTORE_HELPER_REPORT ")]
    if len(helper_reports) != 1 or helper_reports[0].get("status") != "pass":
        raise RuntimeError(f"native helper did not qualify: {helper_reports}")
    helper_report = helper_reports[0]
    if (helper_report["sectorBytes"] != args.sector_size or
            helper_report["gateSha256Before"] != helper_report["gateSha256After"] or
            helper_report["finalUsbSha256"] != file_hash(output / "helper-usb.raw")):
        raise RuntimeError("native helper USB digest mismatch")
    transaction_proof = helper_report["transaction"]["deviceRemoval"]
    if (not transaction_proof.get("sysfsRemoved") or
            transaction_proof["sha256BeforeRemoval"] != transaction_removal["targetSha256Before"] or
            transaction_proof["media"] != "incomplete" or transaction_proof["lastCompleted"] != 6 or
            not transaction_proof.get("replayRefused")):
        raise RuntimeError("native transaction removal proof does not match the host snapshot")
    transaction_parts = inspect_target(output, args.sector_size, "transaction-usb.raw")
    helper_parts = inspect_target(output, args.sector_size, "helper-usb.raw")
    after = file_hash(output / "canary.raw")
    if before != after or reports[0].get("sectorBytes") != args.sector_size:
        raise RuntimeError("host canary digest or sector geometry mismatch")
    parts = inspect_target(output, args.sector_size)
    if not reports[0].get("deviceRemoval", {}).get("sysfsRemoved"):
        raise RuntimeError("guest did not prove stale-FD rejection after removal")
    if file_hash(Path(__file__)) != host_runner_sha256:
        raise RuntimeError("host runner changed during qualification")
    result = {"deviceRemoval": removal, "transactionDeviceRemoval": transaction_removal,
              "transactionPartitions": transaction_parts, "hostRunnerSha256": host_runner_sha256,
              "guest": reports[0], "partitions": parts,
              "nativeHelper": helper_report, "helperPartitions": helper_parts,
              "gptSnapshot": snapshot_report,
              "installerSourceSha256": {name: hashlib.sha256(content).hexdigest() for name, content in installer_sources.items()},
              "canarySha256Before": before, "canarySha256After": after,
              "imageSha512": IMAGE_SHA512, "exfatSourceSha256": SOURCE_SHA256,
              "sourceSha256": {name: hashlib.sha256(content).hexdigest() for name, content in sources.items()},
              "transcriptSha256": file_hash(output / "guest.log"),
              "proofSha256": file_hash(output / "proof.log"), "qemuCommand": qemu}
    (output / "qualification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"PASS: {output / 'qualification.json'}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
