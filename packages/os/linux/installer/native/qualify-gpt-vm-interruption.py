#!/usr/bin/env python3
"""Kill/reboot disposable QEMU overlays at native artifact persistence checkpoints.

Requires a completed local qualify-restore-vm.py output with its stopped guest
image and backing image still available. No host block devices or root required.
This covers guest/kernel loss; host caches and physical power loss are not modeled.
"""
import argparse
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import time

NATIVE = Path(__file__).resolve().parent


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


GUEST = r'''
import base64, ctypes, errno, hashlib, json, os, signal
from pathlib import Path
from qualify_gpt_store import StoreIdentity, StoreResult, Control, Check, Progress
artifact = base64.b64decode("ARTIFACT_BASE64", validate=True)
binding = bytes.fromhex("BINDING_HEX")
expected_digest = hashlib.sha256(artifact).digest()
root = Path('/root/gpt-vm-cut')
mode = 'GUEST_MODE'
stop = STOP_STEP
library = ctypes.CDLL('/root/gpt-snapshot.so')
assert hashlib.sha256(Path('/root/gpt-snapshot.so').read_bytes()).hexdigest() == 'BINARY_SHA256'
if mode == 'write':
    root.mkdir(mode=0o700)
    parent = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    os.fsync(parent)
    os.close(parent)
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
id = StoreIdentity(os.fstat(fd).st_dev, os.fstat(fd).st_ino)
@Check
def check(_):
    try:
        st = os.stat(root, follow_symlinks=False)
        return 0 if (st.st_dev, st.st_ino) == (id.filesystem_device, id.directory_inode) else -errno.ESTALE
    except OSError:
        return -errno.ESTALE
@Progress
def progress(_, step):
    if mode == 'write' and step == stop:
        print('ELIZAOS_GPT_CUT ' + str(stop), flush=True)
        while True:
            signal.pause()
control = Control(None, check, progress)
if mode == 'write':
    save = library.elizaos_install_store_gpt_artifact
    save.argtypes = [ctypes.c_int, ctypes.POINTER(StoreIdentity), ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.POINTER(Control), ctypes.POINTER(StoreResult)]
    save.restype = ctypes.c_int
    result = StoreResult()
    rc = save(fd, ctypes.byref(id), binding, artifact, len(artifact), expected_digest,
              ctypes.byref(control), ctypes.byref(result))
    raise RuntimeError('writer passed interruption checkpoint: ' + str(rc))
read = library.elizaos_install_read_gpt_artifact
read.argtypes = [ctypes.c_int, ctypes.POINTER(StoreIdentity), ctypes.c_void_p,
    ctypes.c_void_p, ctypes.POINTER(Control), ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
read.restype = ctypes.c_int
output = ctypes.create_string_buffer(len(artifact))
length = ctypes.c_size_t(999)
rc = read(fd, ctypes.byref(id), binding, expected_digest, ctypes.byref(control), output,
          len(artifact), ctypes.byref(length))
assert (rc == 0 and output.raw[:length.value] == artifact) or (rc < 0 and length.value == 0)
assert stop != 3 or rc == 0, 'directory-synced artifact did not survive VM loss'
path = root / (expected_digest.hex() + '.gpt')
present = path.exists()
if rc == 0:
    st = path.stat()
    assert st.st_uid == 0 and st.st_gid == 0 and st.st_mode & 0o7777 == 0o600 and st.st_nlink == 1
print('ELIZAOS_GPT_REBOOT ' + json.dumps({'after': stop, 'readReturn': rc,
    'present': present, 'verified': rc == 0, 'length': length.value,
    'artifactSha256': expected_digest.hex()}), flush=True)
os.close(fd)
'''


def run_guest(command, directory, mode, stop):
    proof = directory / f'{mode}-proof.log'
    with (directory / f'{mode}-qemu.log').open('w') as log:
        process = subprocess.Popen(command, cwd=directory, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 240
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'{mode} boot timed out; inspect {directory}')
                lines = proof.read_text(errors='strict').splitlines() if proof.exists() else []
                if mode == 'write' and f'ELIZAOS_GPT_CUT {stop}' in lines:
                    if lines.count(f'ELIZAOS_GPT_CUT {stop}') != 1:
                        raise RuntimeError('duplicate interruption checkpoint')
                    process.kill()  # SIGKILL this exact local disposable QEMU process.
                    process.wait(timeout=30)
                    if process.returncode != -signal.SIGKILL:
                        raise RuntimeError('QEMU was not killed at the checkpoint')
                    return {'after': stop, 'qemuReturn': process.returncode}
                time.sleep(0.05)
            if mode == 'write' or process.returncode != 0:
                raise RuntimeError(f'unexpected {mode} QEMU exit: {process.returncode}')
            reports = [json.loads(line.removeprefix('ELIZAOS_GPT_REBOOT '))
                       for line in proof.read_text().splitlines() if line.startswith('ELIZAOS_GPT_REBOOT ')]
            if len(reports) != 1 or reports[0]['after'] != stop:
                raise RuntimeError('missing reboot verification')
            return reports[0]
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--container-tools-image', required=True)
    args = parser.parse_args()
    runner_digest = digest(Path(__file__))
    prepared = args.prepared.resolve(strict=True)
    output = args.output_dir.resolve()
    evidence = json.loads((prepared / 'qualification.json').read_text())
    snapshot = evidence['gptSnapshot']
    if snapshot['status'] != 'pass' or snapshot['storage']['verified'] is not True:
        raise RuntimeError('prepared VM did not qualify artifact storage')
    required_sources = {'gpt-snapshot.c', 'gpt-snapshot.h', 'gpt-artifact-store.c',
                        'gpt-artifact-store.h', 'qualify-gpt-snapshot.py', 'qualify_gpt_store.py'}
    if set(evidence['installerSourceSha256']) != required_sources:
        raise RuntimeError('prepared native source inventory is incomplete')
    if any(not re.fullmatch(r'[a-f0-9]{64}', snapshot[key])
           for key in ['binding', 'binarySha256', 'artifactSha256']):
        raise RuntimeError('prepared binding or digest is invalid')
    for name, expected in evidence['installerSourceSha256'].items():
        if Path(name).name != name or digest(NATIVE / name) != expected:
            raise RuntimeError('prepared native source mismatch')
    if (digest(prepared / 'proof.log') != evidence['proofSha256'] or
            digest(prepared / 'guest.log') != evidence['transcriptSha256']):
        raise RuntimeError('prepared logs differ from qualification')
    artifact = (prepared / 'gpt-snapshot.bin').read_bytes()
    if hashlib.sha256(artifact).hexdigest() != snapshot['artifactSha256']:
        raise RuntimeError('prepared artifact differs')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    # Binding the stopped prepared image before/after also catches accidental
    # reuse while it is being modified. qemu-img refuses an active image lock.
    before = digest(prepared / 'guest.qcow2')
    def image_tool(argv, directory):
        subprocess.run(['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}',
                        '-v', f'{prepared.parent}:{prepared.parent}:ro', '-v', f'{output}:{output}',
                        '-w', str(directory), args.container_tools_image, *argv], check=True, timeout=60)
    results = []
    for stop in range(4):
        directory = output / str(stop)
        directory.mkdir()
        image_tool(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b',
                    str(prepared / 'guest.qcow2'), str(directory / 'guest.qcow2')], directory)
        result = {}
        for mode in ['write', 'read']:
            script = GUEST.replace('ARTIFACT_BASE64', base64.b64encode(artifact).decode())
            script = script.replace('BINDING_HEX', snapshot['binding']).replace('GUEST_MODE', mode)
            script = script.replace('STOP_STEP', str(stop)).replace('BINARY_SHA256', snapshot['binarySha256'])
            cloud = ("#cloud-config\nwrite_files:\n  - path: /root/gpt-vm-cut.py\n    permissions: '0600'\n"
                     "    encoding: b64\n    content: " + base64.b64encode(script.encode()).decode() +
                     "\nruncmd:\n  - [sh, -c, 'python3 /root/gpt-vm-cut.py > /dev/ttyS1 2>&1']\n  - [poweroff]\n")
            (directory / 'user-data').write_text(cloud)
            (directory / 'meta-data').write_text(f'instance-id: gpt-cut-{stop}-{mode}\n')
            image_tool(['genisoimage', '-quiet', '-output', str(directory / f'{mode}-seed.iso'),
                        '-volid', 'cidata', '-joliet', '-rock', 'user-data', 'meta-data'], directory)
            command = ['qemu-system-x86_64', '-accel', 'kvm', '-cpu', 'host', '-m', '1024', '-smp', '2',
                       '-display', 'none', '-monitor', 'none', '-no-reboot', '-boot', 'order=c',
                       '-serial', f'file:{directory / (mode + "-guest.log")}',
                       '-serial', f'file:{directory / (mode + "-proof.log")}',
                       '-drive', 'file=guest.qcow2,if=virtio,format=qcow2,cache=none',
                       '-drive', f'file={mode}-seed.iso,media=cdrom,readonly=on', '-nic', 'none']
            result[mode] = run_guest(command, directory, mode, stop)
            result[mode + 'Command'] = command
            result[mode + 'ProofSha256'] = digest(directory / f'{mode}-proof.log')
            result[mode + 'GuestSha256'] = digest(directory / f'{mode}-guest.log')
            result[mode + 'SeedSha256'] = digest(directory / f'{mode}-seed.iso')
        recovered = result['read']
        valid = recovered['readReturn'] == 0
        if (type(recovered['readReturn']) is not int or recovered['readReturn'] > 0 or
                recovered['verified'] is not valid or
                recovered['length'] != (len(artifact) if valid else 0) or
                recovered['artifactSha256'] != snapshot['artifactSha256'] or
                (valid and recovered['present'] is not True) or (stop == 3 and not valid)):
            raise RuntimeError('reboot report does not prove exact recovery or closed refusal')
        results.append(result)
        print(json.dumps({'checkpoint': stop, 'reboot': result['read']}), flush=True)
    if digest(Path(__file__)) != runner_digest:
        raise RuntimeError('qualification runner changed during the run')
    if digest(prepared / 'guest.qcow2') != before:
        raise RuntimeError('prepared backing image changed')
    report = {'status': 'pass', 'preparedImageSha256': before,
              'preparedQualificationSha256': digest(prepared / 'qualification.json'),
              'runnerSha256': runner_digest, 'installerSourceSha256': evidence['installerSourceSha256'],
              'artifactSha256': snapshot['artifactSha256'], 'results': results,
              'limits': ['abrupt QEMU process loss, not physical power loss',
                         'host storage caches and power failure are not modeled',
                         'does not qualify installer backend or storage policy']}
    (output / 'qualification.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
