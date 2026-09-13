"""Bind a root guardian's native evidence key to its trusted outer adapter.

The separate rendezvous exposes only a connection endpoint. Keys stay under
root-only ownership, and an accepted signature requires a later terminal
key-disposal receipt on the same authenticated, process-bound channel.
"""

import hashlib
import json
import os
import pathlib
import select
import socket
import stat
import struct
import subprocess
import time


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def metadata_or_absent(path):
    try:
        return path.lstat()
    except FileNotFoundError:
        # error-policy:J3 Only an absent entry is accepted as disposed.
        return None


def process_identity(pid):
    fields = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "uid": pathlib.Path(f"/proc/{pid}").stat().st_uid, "startTicks": int(fields[19])}


class NativeAttestationChannel:
    def __init__(self, journal, request):
        self.journal = journal
        self.request = request
        self.connection = None
        self.listener = None
        self.pidfd = None
        self.pinned = False
        self.disposed = False
        self.delivered = False
        self.signed_digest = None
        self.key_directory = journal.directory / "native-private-key"
        nonce = request["nonce"]
        if len(nonce) != 32 or any(c not in "0123456789abcdef" for c in nonce):
            raise RuntimeError("invalid native adapter nonce")
        self.directory = pathlib.Path("/run") / ("eliza-native-adapter-" + nonce)
        self.context_bytes = canonical(request["context"])
        if len(self.context_bytes) > 32768:
            raise RuntimeError("native trusted context exceeds protocol limit")
        self.context_hash = hashlib.sha256(self.context_bytes).hexdigest()

    def command(self, args):
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=5, close_fds=True,
                                env={"PATH": "/usr/bin:/bin"})
        if result.returncode != 0:
            raise RuntimeError("native attestation crypto command failed")
        return result.stdout

    def receive(self):
        deadline = time.monotonic() + 10
        data = bytearray()
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("native adapter response deadline expired")
            readable, _, _ = select.select([self.connection, self.pidfd], [], [], remaining)
            if self.pidfd in readable:
                raise RuntimeError("native outer adapter exited")
            if self.connection not in readable:
                continue
            piece = self.connection.recv(4096)
            if not piece:
                raise RuntimeError("native outer adapter disconnected")
            data.extend(piece)
            if len(data) > 65536:
                raise RuntimeError("native adapter message exceeds protocol limit")
        line, extra = bytes(data).split(b"\n", 1)
        if extra:
            raise RuntimeError("native adapter sent unexpected pipelined messages")
        return json.loads(line)

    def send(self, value):
        data = canonical(value) + b"\n"
        if len(data) > 65536:
            raise RuntimeError("native attestation message exceeds protocol limit")
        self.connection.settimeout(5)
        self.connection.sendall(data)

    def establish(self):
        identity = self.request["adapterIdentity"]
        if process_identity(identity["pid"]) != identity:
            raise RuntimeError("native adapter identity changed before binding")
        self.pidfd = os.pidfd_open(identity["pid"], 0)
        if process_identity(identity["pid"]) != identity:
            raise RuntimeError("native adapter identity changed during binding")
        # Both allocations are recorded before effects. ExecStopPost invokes
        # cleanup even if generation or the initial connection is interrupted.
        if any(row["event"] == "native-key-intent" for row in self.journal.read()):
            raise RuntimeError("native key admission already attempted")
        if metadata_or_absent(self.directory) is not None:
            raise RuntimeError("native rendezvous candidate already exists")
        self.journal.append("native-key-intent", {"directory": str(self.key_directory), "rendezvous": str(self.directory), "adapterIdentity": identity, "contextSha256": self.context_hash})
        self.key_directory.mkdir(mode=0o700)
        self.directory.mkdir(mode=0o711)
        created = self.directory.lstat()
        self.journal.append("native-rendezvous-created", {"directory": str(self.directory), "dev": created.st_dev, "ino": created.st_ino})
        private = self.key_directory / "key.pem"
        self.command(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private)])
        private.chmod(0o600)
        self.public_der = self.command(["/usr/bin/openssl", "pkey", "-in", str(private), "-pubout", "-outform", "DER"])
        self.fingerprint = hashlib.sha256(self.public_der).hexdigest()
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        endpoint = self.directory / "control.sock"
        staging_endpoint = self.directory / "control-starting.sock"
        self.listener.bind(str(staging_endpoint))
        staging_endpoint.chmod(0o666)
        self.listener.listen(1)
        # Publish only the fully initialized endpoint; metadata checks stay strict.
        staging_endpoint.rename(endpoint)
        readable, _, _ = select.select([self.listener, self.pidfd], [], [], 10)
        if self.pidfd in readable or self.listener not in readable:
            raise RuntimeError("native adapter did not connect before deadline")
        self.connection, _ = self.listener.accept()
        pid, uid, _gid = struct.unpack("3i", self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if pid != identity["pid"] or uid != identity["uid"] or process_identity(pid) != identity:
            raise RuntimeError("native adapter peer does not own this attempt")
        self.listener.close()
        self.listener = None
        self.send({"type": "native-key", "nonce": self.request["nonce"], "contextSha256": self.context_hash, "publicKeyDer": self.public_der.hex(), "fingerprint": self.fingerprint})
        expected = {"type": "native-key-pinned", "nonce": self.request["nonce"], "contextSha256": self.context_hash, "fingerprint": self.fingerprint}
        if self.receive() != expected:
            raise RuntimeError("native adapter did not pin the exact admitted key/context")
        self.pinned = True
        self.journal.append("native-key-pinned", {"publicKeyDer": self.public_der.hex(), "fingerprint": self.fingerprint, "contextSha256": self.context_hash, "adapterIdentity": identity})

    def assert_alive(self):
        if self.pidfd is None or self.connection is None:
            raise RuntimeError("native outer adapter is not bound")
        # After the sole PIN acknowledgement no inbound message is permitted.
        # EOF must revoke signing even while the adapter process remains alive.
        if select.select([self.pidfd, self.connection], [], [], 0)[0]:
            raise RuntimeError("native outer adapter lifetime or channel ended")

    def sign(self, manifest):
        self.assert_alive()
        if not self.pinned or self.disposed or self.delivered or self.signed_digest is not None:
            raise RuntimeError("native signing key is outside its admitted lifetime")
        if manifest.get("context") != self.request["context"] or manifest.get("nonce") != self.request["nonce"]:
            raise RuntimeError("native manifest does not match trusted admission")
        message = canonical(manifest)
        if len(message) > 32768:
            raise RuntimeError("native manifest exceeds protocol limit")
        source = self.key_directory / "manifest"
        fd = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(message)
                output.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        signature = self.command(["/usr/bin/openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(self.key_directory / "key.pem"), "-in", str(source)])
        if len(signature) != 64:
            raise RuntimeError("native signature has invalid size")
        self.assert_alive()
        attestation = {"manifest": manifest, "signature": signature.hex(), "fingerprint": self.fingerprint}
        self.signed_digest = hashlib.sha256(canonical(attestation)).hexdigest()
        return attestation

    def persist_artifacts(self, attestation, artifacts):
        self.assert_alive()
        if self.signed_digest is None or hashlib.sha256(canonical(attestation)).hexdigest() != self.signed_digest:
            raise RuntimeError("native artifact handoff differs from signed result")
        names = {"ledger.jsonl", "journal.jsonl", "counters.json", "drain.json", "producer-ids.txt", "monitor-ids.txt", "build.json"}
        if set(artifacts) != names or any(type(value) is not bytes or len(value) > 67108864 for value in artifacts.values()):
            raise RuntimeError("native artifact handoff is incomplete or oversized")
        target = self.directory / "evidence"
        self.journal.append("native-evidence-intent", {"directory": str(target), "attestationSha256": self.signed_digest})
        target.mkdir(mode=0o700)
        for name, value in artifacts.items():
            fd = os.open(target / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, "wb", closefd=False) as output:
                    if output.write(value) != len(value):
                        raise RuntimeError("native evidence write was incomplete")
                    output.flush()
                    os.fsync(fd)
                os.fchmod(fd, 0o644)
            finally:
                os.close(fd)
        fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
            os.fchmod(fd, 0o755)
        finally:
            os.close(fd)
        self.assert_alive()
        self.send({"type": "native-artifacts-ready", "nonce": self.request["nonce"], "attestation": attestation})
        expected = {"type": "native-artifacts-persisted", "nonce": self.request["nonce"], "attestationSha256": self.signed_digest}
        if self.receive() != expected:
            raise RuntimeError("native artifact persistence acknowledgement is invalid")
        self.assert_alive()
        self.journal.append("native-artifacts-persisted", {"attestationSha256": self.signed_digest})

    def dispose(self):
        # Mark completion only after the root cleanup helper verifies absence
        # and durably records it. An exception leaves terminal delivery closed.
        dispose_key(self.journal)
        self.disposed = True

    def accept_after_disposal(self, attestation):
        self.assert_alive()
        if not self.disposed or metadata_or_absent(self.key_directory) is not None or self.delivered:
            raise RuntimeError("native key disposal is not verified")
        if self.signed_digest is None or hashlib.sha256(canonical(attestation)).hexdigest() != self.signed_digest:
            raise RuntimeError("native terminal differs from the owned signed result")
        self.send({"type": "native-terminal", "nonce": self.request["nonce"], "keyDisposed": True, "attestation": attestation})
        self.delivered = True

    def close(self):
        for handle in (self.connection, self.listener):
            if handle is not None:
                handle.close()
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None


def dispose_key(journal):
    intents = [r["data"] for r in journal.read() if r["event"] == "native-key-intent"]
    if not intents:
        return
    if len(intents) != 1:
        raise RuntimeError("native key allocation has multiple authorities")
    target = journal.directory / "native-private-key"
    if intents[0]["directory"] != str(target):
        raise RuntimeError("native key cleanup authority mismatch")
    info = metadata_or_absent(target)
    if info is not None:
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError("native key directory ownership changed")
        for name in target.iterdir():
            if name.name not in ("key.pem", "manifest"):
                raise RuntimeError("native key directory contains an unexpected entry")
            info = name.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                raise RuntimeError("native key entry ownership changed")
            name.unlink()
        target.rmdir()
    rendezvous = pathlib.Path(intents[0]["rendezvous"])
    if rendezvous.parent != pathlib.Path('/run') or not rendezvous.name.startswith('eliza-native-adapter-'):
        raise RuntimeError("native rendezvous cleanup authority mismatch")
    info = metadata_or_absent(rendezvous)
    if info is not None:
        allocations = [r["data"] for r in journal.read() if r["event"] == "native-rendezvous-created"]
        if len(allocations) != 1 or allocations[0] != {"directory": str(rendezvous), "dev": info.st_dev, "ino": info.st_ino}:
            raise RuntimeError("native rendezvous allocation ownership is uncertain")
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o711:
            raise RuntimeError("native rendezvous ownership changed")
        evidence = rendezvous / "evidence"
        evidence_info = metadata_or_absent(evidence)
        if evidence_info is not None:
            intents = [r["data"] for r in journal.read() if r["event"] == "native-evidence-intent"]
            if len(intents) != 1 or intents[0]["directory"] != str(evidence) or not stat.S_ISDIR(evidence_info.st_mode) or evidence_info.st_uid != 0 or stat.S_IMODE(evidence_info.st_mode) not in (0o700, 0o755):
                raise RuntimeError("native evidence cleanup authority changed")
            names = {"ledger.jsonl", "journal.jsonl", "counters.json", "drain.json", "producer-ids.txt", "monitor-ids.txt", "build.json"}
            for entry in evidence.iterdir():
                metadata = entry.lstat()
                if entry.name not in names or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) not in (0o600, 0o644):
                    raise RuntimeError("native evidence cleanup entry changed")
                entry.unlink()
            evidence.rmdir()
            if metadata_or_absent(evidence) is not None:
                raise RuntimeError("native evidence remains after disposal")
        for name in ('control-starting.sock', 'control.sock'):
            endpoint = rendezvous / name
            info = metadata_or_absent(endpoint)
            if info is not None:
                if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
                    raise RuntimeError("native rendezvous endpoint changed")
                endpoint.unlink()
        rendezvous.rmdir()
    if metadata_or_absent(target) is not None or metadata_or_absent(rendezvous) is not None:
        raise RuntimeError("native private authority remains after disposal")
    journal.append("native-key-disposed", {"privateKeyAbsent": True, "rendezvousAbsent": True})
