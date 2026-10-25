"""Shared isolated Debian VM for native disk qualifications; no host devices."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess

RESTORE = Path(__file__).resolve().parents[2] / "usb-installer/native/qualify-restore-vm.py"
spec = importlib.util.spec_from_file_location("restore_vm", RESTORE)
restore_vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore_vm)


def positive_timeout(value):
    seconds = int(value)
    if not 1 <= seconds <= 86400:
        raise argparse.ArgumentTypeError("timeout must be between 1 and 86400 seconds")
    return seconds


def argument_parser(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--base-image", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--container-tools-image")
    parser.add_argument("--accelerator", choices=("kvm", "tcg"), default="kvm")
    parser.add_argument("--sector-size", choices=(512, 4096), type=int, default=512)
    parser.add_argument("--timeout-seconds", type=positive_timeout, default=600)
    return parser


def run(args, sources, script, required_evidence, serial, extra_inputs=None, extra_disks=()):
    extra_inputs = extra_inputs or {}
    if not serial.isascii() or not serial.replace("-", "").isalnum() or len(serial) > 20:
        raise ValueError("qualification requires a short ASCII disk serial")
    base = args.base_image.resolve(strict=True)
    if restore_vm.file_hash(base, "sha512") != restore_vm.IMAGE_SHA512:
        raise RuntimeError("qualification base digest mismatch")
    output = args.output_dir.resolve()
    if any(character in str(path) for path in (base, output) for character in ",\n\r"):
        raise ValueError("QEMU input/output paths cannot contain commas or line breaks")
    output.mkdir(parents=True, exist_ok=False)
    evidence = output / "evidence"
    evidence.mkdir()
    node = args.node.resolve(strict=True)
    sources["run.sh"] = script.encode()
    data = "#cloud-config\nssh_pwauth: false\ndisable_root: true\nwrite_files:\n"
    for name, content in sources.items():
        data += f"  - path: /root/{name}\n    permissions: '0700'\n    encoding: b64\n    content: {base64.b64encode(content).decode()}\n"
    data += "runcmd:\n  - [bash, /root/run.sh]\n"
    (output / "user-data").write_text(data)
    (output / "meta-data").write_text(f"instance-id: {serial.lower()}-{args.sector_size}\n")

    def image_tool(arguments):
        command = arguments
        if args.container_tools_image:
            command = ["docker", "run", "--rm", "--network", "none", "--user", f"{os.getuid()}:{os.getgid()}",
                       "-v", f"{output}:{output}", "-v", f"{base}:{base}:ro", "-w", str(output), args.container_tools_image, *arguments]
        subprocess.run(command, cwd=output, check=True, timeout=60)

    image_tool(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", str(base), str(output / "guest.qcow2"), "6G"])
    image_tool(["genisoimage", "-quiet", "-output", str(output / "seed.iso"), "-volid", "cidata", "-joliet", "-rock", "user-data", "meta-data"])
    with (output / "target.raw").open("xb") as disk:
        disk.truncate(128 * 1024 * 1024)
    extra_drives = []
    for index, (disk_serial, disk_size) in enumerate(extra_disks):
        if (not disk_serial.isascii() or not disk_serial.replace("-", "").isalnum()
                or len(disk_serial) > 20 or disk_size < 64 * 1024 * 1024):
            raise ValueError("invalid disposable extra disk specification")
        disk_path = output / f"extra-{index}.raw"
        with disk_path.open("xb") as disk:
            disk.truncate(disk_size)
        extra_drives += ["-drive", f"file={disk_path},format=raw,if=none,id=extra{index},discard=unmap,detect-zeroes=unmap",
                         "-device", f"virtio-blk-pci,drive=extra{index},serial={disk_serial},logical_block_size={args.sector_size},physical_block_size={args.sector_size}"]
    inputs = output / "inputs"
    inputs.mkdir()
    shutil.copyfile(node, inputs / "node")
    for name, source in extra_inputs.items():
        shutil.copyfile(source.resolve(strict=True), inputs / name)
    command = ["qemu-system-x86_64", "-machine", f"pc,accel={args.accelerator}", "-cpu", "host" if args.accelerator == "kvm" else "max", "-m", "2048", "-smp", "2",
               "-display", "none", "-monitor", "none", "-qmp", f"unix:{output}/qmp.sock,server=on,wait=off", "-serial", f"file:{output}/guest.log", "-no-reboot",
               "-drive", f"file={output}/guest.qcow2,format=qcow2,if=none,id=os",
               "-device", "virtio-blk-pci,drive=os,serial=ELIZAOS-VM-ROOT,bootindex=1",
               "-drive", f"file={output}/target.raw,format=raw,if=none,id=target",
               "-device", f"virtio-blk-pci,drive=target,serial={serial},logical_block_size={args.sector_size},physical_block_size={args.sector_size}",
               *extra_drives,
               "-drive", f"file={output}/seed.iso,format=raw,media=cdrom,readonly=on", "-netdev", "user,id=net",
               "-device", "virtio-net-pci,netdev=net", "-virtfs", f"local,path={evidence},mount_tag=evidence,security_model=none",
               "-virtfs", f"local,path={inputs},mount_tag=inputs,security_model=none,readonly=on"]
    (output / "inputs.json").write_text(json.dumps({"harnessSha256": restore_vm.file_hash(Path(__file__)), "command": command, "baseSha512": restore_vm.IMAGE_SHA512, "timeoutSeconds": args.timeout_seconds,
        "sources": {name: hashlib.sha256(value).hexdigest() for name, value in sources.items()},
        "nodeSha256": restore_vm.file_hash(node), "extraInputSha256": {name: restore_vm.file_hash(source) for name, source in extra_inputs.items()}}, indent=2))
    with (output / "qemu.log").open("wb") as log:
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        try:
            status = child.wait(timeout=args.timeout_seconds)
            if status or json.loads((evidence / "run-status.json").read_text())["exitCode"]:
                raise RuntimeError("qualification failed; inspect VM evidence/runner.log")
            for name in required_evidence:
                if json.loads((evidence / name).read_text()).get("success") is not True:
                    raise RuntimeError(f"missing successful evidence: {name}")
            print(f"Disposable disk qualification passed: {evidence}", flush=True)
        except subprocess.TimeoutExpired as error:
            (evidence / "host-timeout.json").write_text(json.dumps({
                "success": False, "timeoutSeconds": args.timeout_seconds,
                "reason": "VM qualification exceeded its configured deadline; partial artifacts are not qualification evidence",
            }, indent=2) + "\n")
            raise RuntimeError(f"VM qualification timed out after {args.timeout_seconds}s; retain partial evidence") from error
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
