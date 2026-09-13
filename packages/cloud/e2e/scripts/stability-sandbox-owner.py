"""Own the privileged scenario lifetime through systemd and a durable journal.

The manager retains the journal until independent cleanup verifies all owned
resources are gone. No lifecycle-only result certifies a native connection
ledger or permits a successful stability attempt.
"""

import array
import contextlib
import ctypes
import fcntl
import errno
import hashlib
import importlib.util
import json
import os
import pathlib
import pwd
import grp
import secrets
import select
import signal
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid


PREFIX = "eliza-stability-owner-"
SCHEMA = "eliza-stability-owner-v1"


MAX_NATIVE_ATTEMPT_MS = 600_000
_cleanup_deadline = None


def validate_attempt_timeout(value):
    if type(value) is not int or not 1 <= value <= MAX_NATIVE_ATTEMPT_MS:
        raise RuntimeError("native attempt timeout must be an integer from 1 through 600000 milliseconds")
    return value


def selected_attempt_timeout(request):
    return validate_attempt_timeout(request["context"]["timeoutMs"]) if request is not None else MAX_NATIVE_ATTEMPT_MS


def cleanup_timeout(journal):
    records = journal.read()
    budgets = [row["data"]["attemptTimeoutMs"] for row in records if row["event"] in ("owner-started", "cleanup-budget-migrated") and "attemptTimeoutMs" in row["data"]]
    if not budgets or any(value != budgets[0] for value in budgets):
        raise RuntimeError("cleanup requires one retained manifest-bound attempt budget")
    return validate_attempt_timeout(budgets[0]) / 1000


def remaining_external_deadline(deadline):
    remaining = deadline - time.monotonic()
    if not 0 < remaining <= MAX_NATIVE_ATTEMPT_MS / 1000:
        raise TimeoutError("invalid or exhausted inherited cleanup deadline")
    return remaining


def migrate_cleanup_budget(journal, expected_context):
    """Bind an explicit trusted recovery context to a pre-budget ownership journal."""
    timeout = validate_attempt_timeout(expected_context["timeoutMs"])
    digest = hashlib.sha256(canonical(expected_context)).hexdigest()
    with journal.locked():
        records = journal._read()
        if any("attemptTimeoutMs" in row["data"] for row in records if row["event"] in ("owner-started", "cleanup-budget-migrated")):
            raise RuntimeError("cleanup budget is already bound")
        keys = [row["data"] for row in records if row["event"] == "native-key-intent"]
        if len(keys) != 1 or keys[0]["contextSha256"] != digest:
            raise RuntimeError("recovery context differs from the retained native key context")
        journal._append("cleanup-budget-migrated", {"attemptTimeoutMs": timeout, "contextSha256": digest, "attemptId": expected_context["attemptId"]})


def cleanup_remaining():
    if _cleanup_deadline is None:
        raise RuntimeError("cleanup deadline was not admitted")
    remaining = _cleanup_deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("aggregate sandbox operation deadline expired")
    return remaining


@contextlib.contextmanager
def owner_deadline(deadline):
    global _cleanup_deadline
    if _cleanup_deadline is not None:
        cleanup_remaining()
        yield
        return
    seconds = remaining_external_deadline(deadline)
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_timer[0] != 0:
        raise RuntimeError("cleanup cannot replace an existing process timer")
    def expired(_signal, _frame):
        raise TimeoutError("aggregate sandbox operation deadline expired")
    try:
        _cleanup_deadline = deadline
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
        cleanup_remaining()
    finally:
        try:
            signal.setitimer(signal.ITIMER_REAL, 0)
        finally:
            try:
                signal.signal(signal.SIGALRM, previous_handler)
            finally:
                _cleanup_deadline = None


@contextlib.contextmanager
def cleanup_budget(journal):
    if _cleanup_deadline is not None:
        cleanup_remaining()
        yield
    else:
        with owner_deadline(time.monotonic() + cleanup_timeout(journal)):
            yield


def require_root():
    if os.geteuid() != 0:
        raise RuntimeError("sandbox lifetime ownership requires root")


# Admission stays closed until the complete outer verifier control is qualified.
NATIVE_SIGNING_ENABLED = True

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class OwnedControlError(RuntimeError):
    def __init__(self, executable, status, stderr):
        super().__init__(f"owned control command failed: {executable} status={status}")
        self.status = status
        self.stderr = stderr


def command(args, timeout=5, accepted=(0,)):
    if _cleanup_deadline is not None:
        timeout = min(timeout, cleanup_remaining())
    result = subprocess.run(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=timeout, check=False,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    if result.returncode not in accepted:
        raise OwnedControlError(args[0], result.returncode, result.stderr)
    return result


def private_directory(directory):
    expected = pathlib.Path(directory)
    if expected.parent != pathlib.Path("/run") or not expected.name.startswith(PREFIX):
        raise RuntimeError("owner journal is outside its manager-owned directory")
    nonce = expected.name[len(PREFIX):]
    if len(nonce) != 32 or any(character not in "0123456789abcdef" for character in nonce):
        raise RuntimeError("invalid owner nonce")
    info = expected.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("owner journal directory is not private root authority")
    return expected, nonce


class Journal:
    def __init__(self, directory):
        self.directory, self.nonce = private_directory(directory)
        self.path = self.directory / "ownership.jsonl"

    @contextlib.contextmanager
    def locked(self):
        if _cleanup_deadline is not None:
            cleanup_remaining()
        fd = os.open(self.directory / "journal.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeError("ownership lock identity is invalid")
            deadline = time.monotonic() + (min(5, cleanup_remaining()) if _cleanup_deadline is not None else 5)
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    # error-policy:J4 A contended owner lock is pending only until its deadline.
                    if time.monotonic() >= deadline:
                        raise RuntimeError("ownership journal lock deadline expired")
                    time.sleep(0.02)
            yield
        finally:
            os.close(fd)

    def read(self):
        with self.locked():
            return self._read()

    def _read(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            # error-policy:J3 The manager has created the directory before the first record.
            return []
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeError("ownership journal identity is invalid")
            records = []
            previous = "0" * 64
            for line in source:
                record = json.loads(line)
                if record["schema"] != SCHEMA or record["nonce"] != self.nonce or record["sequence"] != len(records) or record["previous"] != previous:
                    raise RuntimeError("ownership journal chain is invalid")
                previous = hashlib.sha256(canonical(record)).hexdigest()
                records.append(record)
            return records

    def append(self, event, data):
        with self.locked():
            return self._append(event, data)

    def _append(self, event, data):
        records = self._read()
        previous = hashlib.sha256(canonical(records[-1])).hexdigest() if records else "0" * 64
        record = {"schema": SCHEMA, "nonce": self.nonce, "sequence": len(records), "previous": previous, "event": event, "monotonicNs": time.monotonic_ns(), "data": data}
        fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeError("ownership journal write identity is invalid")
            pending = canonical(record) + b"\n"
            while pending:
                written = os.write(fd, pending)
                if written <= 0:
                    raise RuntimeError("ownership journal write made no progress")
                pending = pending[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return record

    def checkpoint(self, state):
        with self.locked():
            return self._checkpoint(state)

    def _checkpoint(self, state):
        self._append("resource-intent", {"stateSha256": hashlib.sha256(state).hexdigest(), "state": state.decode()})
        temporary = self.directory / f"state-{uuid.uuid4().hex}.tmp"
        target = self.directory / "shell-state"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(state)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)

        finally:
            if temporary.exists():
                temporary.unlink()


@contextlib.contextmanager
def identity_admission_lock():
    if _cleanup_deadline is not None:
        cleanup_remaining()
    # Cooperating launchers serialize inspection, allocation, and release. This
    # does not prevent another privileged administrator from mutating the host.
    fd = os.open("/run/lock/eliza-stability-identities.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("identity admission lock is not private root authority")
        deadline = time.monotonic() + (min(5, cleanup_remaining()) if _cleanup_deadline is not None else 5)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                # error-policy:J4 Another admission may finish before this bounded deadline.
                if time.monotonic() >= deadline:
                    raise RuntimeError("identity admission lock deadline expired")
                time.sleep(0.02)
        yield
    finally:
        os.close(fd)


def inspect_identity_resources(identity, mode):
    inspector = str(pathlib.Path(__file__).with_name("stability-sandbox-identity.py"))
    try:
        args = ["/usr/bin/python3", "-I", "-S", inspector, str(identity["uid"]), str(identity["gid"]), mode]
        timeout = 25
        if _cleanup_deadline is not None:
            args.append(str(_cleanup_deadline))
            timeout = cleanup_remaining()
        result = command(args, timeout=timeout)
    except OwnedControlError as error:
        # error-policy:J2 Preserve the inspector's structured, path-free reason.
        try:
            diagnostic = json.loads(error.stderr)
            if diagnostic["code"] not in ("STABILITY_IDENTITY_REJECTED", "STABILITY_IDENTITY_DEADLINE", "STABILITY_IDENTITY_METADATA_UNAVAILABLE") or not isinstance(diagnostic["reason"], str) or not diagnostic["reason"]:
                raise ValueError("invalid identity diagnostic")
        except (ValueError, KeyError, TypeError) as diagnostic_error:
            # error-policy:J2 Malformed diagnostics remain an explicit failed protocol boundary.
            raise RuntimeError("identity inspector failed without a valid diagnostic") from diagnostic_error
        raise RuntimeError(f"{diagnostic['code']}: {diagnostic['reason']}") from error
    receipt = json.loads(result.stdout)
    if receipt["uid"] != identity["uid"] or receipt["gid"] != identity["gid"] or receipt["accountAbsenceRequired"] != (mode == "admit"):
        raise RuntimeError("identity inspection receipt does not match its admission purpose")
    return receipt


def allocate_identity(journal, deadline=None):
    if deadline is None:
        return allocate_identity_bounded(journal)
    with owner_deadline(deadline):
        return allocate_identity_bounded(journal)


def allocate_identity_bounded(journal):
    with identity_admission_lock():
        if any(record["event"] in ("identity-candidate", "identity-intent") for record in journal.read()):
            raise RuntimeError("an identity candidate was already selected for this owner")
        uid = 1_000_000_000 + secrets.randbelow(900_000_000)
        identity = {"name": "eliza-sbx-" + journal.nonce[:20], "uid": uid, "gid": uid}
        journal.append("identity-candidate", identity)
        inspected = inspect_identity_resources(identity, "admit")
        # Intent is durable before either account-database operation. Cleanup
        # reconciles the intended names/IDs even if command completion was lost.
        journal.append("identity-intent", {**identity, "inspection": inspected})
        command(["/usr/sbin/groupadd", "--gid", str(uid), identity["name"]])
        journal.append("group-created", identity)
        command(["/usr/sbin/useradd", "--uid", str(uid), "--gid", str(uid), "--no-user-group", "--no-create-home", "--no-log-init", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "--password", "!", identity["name"]])
        journal.append("account-created", identity)
        return identity


class OutputTransferError(RuntimeError):
    def __init__(self, reason, transferred):
        super().__init__(reason)
        self.transferred_inodes = transferred


def descriptor_mount_id(fd):
    entries = [line.split(":", 1)[1].strip() for line in pathlib.Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines() if line.startswith("mnt_id:")]
    if len(entries) != 1:
        raise RuntimeError("output descriptor mount identity is unavailable")
    return int(entries[0])


def chown_pinned_descriptor(fd, uid, gid):
    # Linux AT_EMPTY_PATH operates on the O_PATH inode, including a symlink
    # itself. No second pathname lookup may select the object being modified.
    libc = ctypes.CDLL(None, use_errno=True)
    operation = libc.fchownat
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint, ctypes.c_int]
    operation.restype = ctypes.c_int
    if operation(fd, b"", uid, gid, 0x1000 | 0x100) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def transfer_output_ownership(output_directory, caller_uid, identity, deadline_seconds=20):
    # The manager first quiesces its payload cgroup. Descriptor pins protect
    # against caller pathname replacement; unknown inode/mount shapes reject.
    transferred = 0
    def expired(_signal, _frame):
        raise TimeoutError("output ownership transfer deadline expired")
    previous_handler = signal.signal(signal.SIGALRM, expired)
    previous_timer = (0, 0)
    started = time.monotonic()
    root = None
    try:
        previous_timer = signal.setitimer(signal.ITIMER_REAL, deadline_seconds)
        if type(caller_uid) is not int or not 0 < caller_uid < 0xFFFFFFFF:
            raise RuntimeError("output transfer requires the original non-root caller")
        caller = pwd.getpwuid(caller_uid)
        target = pathlib.Path(output_directory)
        if not target.is_absolute() or str(target.resolve()) != str(target) or target == pathlib.Path("/"):
            raise RuntimeError("output transfer root must be canonical")
        root = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        admitted = os.fstat(root)
        if admitted.st_uid != caller_uid:
            raise RuntimeError("output root no longer belongs to its admitted caller")
        mount_id = descriptor_mount_id(root)

        def walk(fd):
            nonlocal transferred
            with os.scandir(fd) as entries:
                for entry in entries:
                    pinned = os.open(entry.name, os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    try:
                        info = os.fstat(pinned)
                        if info.st_dev != admitted.st_dev or descriptor_mount_id(pinned) != mount_id:
                            raise RuntimeError("output ownership traversal crossed an unexpected mount")
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pinned)
                            try:
                                walk(child)
                            finally:
                                os.close(child)
                        if info.st_uid != identity["uid"] and info.st_gid != identity["gid"]:
                            continue
                        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                            raise RuntimeError("reserved output has an unsupported inode type")
                        current = os.fstat(pinned)
                        if (current.st_uid, current.st_gid) != (info.st_uid, info.st_gid):
                            raise RuntimeError("pinned output ownership changed before transfer")
                        if not stat.S_ISDIR(info.st_mode) and current.st_nlink != 1:
                            raise RuntimeError("reserved output has ambiguous hard-link ownership")
                        chown_pinned_descriptor(pinned, caller_uid, caller.pw_gid)
                        transferred += 1
                        after = os.fstat(pinned)
                        if (after.st_uid, after.st_gid) != (caller_uid, caller.pw_gid) or (not stat.S_ISDIR(info.st_mode) and after.st_nlink != 1):
                            raise RuntimeError("pinned output ownership transfer could not be verified")
                    finally:
                        os.close(pinned)
        walk(root)
        return {"callerUid": caller_uid, "callerGid": caller.pw_gid, "transferredInodes": transferred}
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        # error-policy:J2 Partial transfer never releases the reserved identity.
        reason = str(error) if isinstance(error, (RuntimeError, TimeoutError)) else "output ownership metadata or operation was unavailable"
        raise OutputTransferError(reason, transferred) from error
    finally:
        if root is not None:
            os.close(root)
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])




def validate_empty_resource_state(data):
    # The pinned Bash declaration protocol publishes this checkpoint before
    # identity allocation. Validate its full, inert shape without evaluating it.
    empty = ("USER", "UID", "GID", "CHILD_PID", "CALLER_UID", "CHAIN", "OUTPUT_DIR", "OUTPUT_ACL_SNAPSHOT", "ROOT")
    zero = ("OUTPUT_ACL_CAPTURED", "IPV4_CHAIN", "IPV4_JUMP", "IPV6_CHAIN", "IPV6_JUMP", "CLEANUP_STATUS")
    expected = {f'declare -- SANDBOX_{name}=""' for name in empty}
    expected.update(f'declare -- SANDBOX_{name}="0"' for name in zero)
    expected.add('declare -- SANDBOX_CLEANED="1"')
    expected.update(f'declare -a SANDBOX_{name}=()' for name in ("SEARCH_ACL_PATHS", "SEARCH_ACL_SNAPSHOTS"))
    state = data["state"]
    lines = state.splitlines()
    if hashlib.sha256(state.encode()).hexdigest() != data["stateSha256"] or len(lines) != len(expected) or set(lines) != expected:
        raise RuntimeError("resource ownership has no identity intent and is not the empty initial checkpoint")


def retained_identity(journal):
    records = journal.read()
    intents = [record["data"] for record in records if record["event"] == "identity-intent"]
    if not intents:
        if any(record["event"] == "identity-released" for record in records):
            raise RuntimeError("identity release has no identity intent")
        for record in records:
            if record["event"] == "resource-intent":
                validate_empty_resource_state(record["data"])
        return None, False
    if len(intents) != 1:
        raise RuntimeError("multiple identity intents cannot be reconciled")
    identity = intents[0]
    if identity["name"] != "eliza-sbx-" + journal.nonce[:20]:
        raise RuntimeError("identity reservation name differs from its owner")
    released = [record["data"] for record in records if record["event"] == "identity-released"]
    expected = {key: identity[key] for key in ("name", "uid", "gid")}
    if any(record != expected for record in released):
        raise RuntimeError("identity release differs from its durable reservation")
    # Release is fsynced only after resource cleanup and absence verification.
    # Once released, numeric IDs are reusable and must never authorize replay.
    return identity, bool(released)


def validate_reserved_identity(identity):
    accounts = pwd.getpwall()
    own = [entry for entry in accounts if entry.pw_name == identity["name"]]
    if any((entry.pw_uid == identity["uid"] or entry.pw_gid == identity["gid"]) and entry.pw_name != identity["name"] for entry in accounts):
        raise RuntimeError("another account retains the reserved identity")
    if own and (own[0].pw_uid != identity["uid"] or own[0].pw_gid != identity["gid"] or own[0].pw_shell != "/usr/sbin/nologin" or own[0].pw_dir != "/nonexistent"):
        raise RuntimeError("reserved account identity changed before release")
    groups = grp.getgrall()
    own_groups = [entry for entry in groups if entry.gr_name == identity["name"]]
    if any(entry.gr_gid == identity["gid"] and entry.gr_name != identity["name"] for entry in groups) or any(entry.gr_gid != identity["gid"] or entry.gr_mem for entry in own_groups):
        raise RuntimeError("reserved group authority changed before release")
    return own


def release_identity_locked(journal, identity):
    own = validate_reserved_identity(identity)
    # Output ownership must already have been transferred by verified
    # cleanup. Residual files/processes retain the account reservation.
    inspected = inspect_identity_resources(identity, "owned-resource-release")
    journal.append("identity-release-intent", {"name": identity["name"], "inspection": inspected})
    if own:
        command(["/usr/sbin/userdel", identity["name"]])
    # userdel may remove the same-name empty group under host policy. Query
    # the actual post-userdel state instead of treating that absence as error.
    remaining_groups = [entry for entry in grp.getgrall() if entry.gr_name == identity["name"]]
    if any(entry.gr_gid != identity["gid"] or entry.gr_mem for entry in remaining_groups):
        raise RuntimeError("reserved group changed during account deletion")
    if remaining_groups:
        command(["/usr/sbin/groupdel", identity["name"]])
    if any(entry.pw_name == identity["name"] or entry.pw_uid == identity["uid"] or entry.pw_gid == identity["gid"] for entry in pwd.getpwall()) or any(entry.gr_name == identity["name"] or entry.gr_gid == identity["gid"] for entry in grp.getgrall()):
        raise RuntimeError("reserved identity remains after release")
    journal.append("identity-released", {"name": identity["name"], "uid": identity["uid"], "gid": identity["gid"]})


def release_identity(journal):
    with identity_admission_lock():
        identity, released = retained_identity(journal)
        if identity is not None and not released:
            release_identity_locked(journal, identity)


def property_value(unit, name):
    result = command(["/usr/bin/systemctl", "show", unit, f"--property={name}", "--value"])
    return result.stdout.decode().strip()


def unit_names(nonce):
    return {
        "guardian": f"{PREFIX}{nonce}.service",
        "payload": f"eliza-stability-payload-{nonce}.scope",
        "collector": f"eliza-stability-collector-{nonce}.service",
    }


def stop_owned_unit(unit, deadline):
    if property_value(unit, "LoadState") == "not-found":
        return
    # Never enqueue a synchronous stop of an After-bound unit from ExecStopPost.
    # Direct cgroup signalling avoids a transaction waiting on this guardian.
    result = command(["/usr/bin/systemctl", "kill", "--kill-whom=all", "--signal=KILL", unit], accepted=(0, 1))
    while time.monotonic() < deadline:
        state = property_value(unit, "ActiveState")
        group = property_value(unit, "ControlGroup")
        if state in ("inactive", "failed") and not group:
            return
        if state == "active" and not group:
            snapshot = command([
                "/usr/bin/systemctl", "show", unit,
                "--property=ActiveState,SubState,MainPID,ControlGroup,Job,Restart",
            ]).stdout.decode().splitlines()
            properties = dict(line.split("=", 1) for line in snapshot)
            # RemainAfterExit keeps a completed unit registered without processes.
            # Only the owned, non-restarting service with no queued job is quiescent.
            if properties == {
                "ActiveState": "active", "SubState": "exited", "MainPID": "0",
                "ControlGroup": "", "Job": "", "Restart": "no",
            }:
                return
        if group:
            events = pathlib.Path("/sys/fs/cgroup") / group.lstrip("/") / "cgroup.events"
            try:
                populated = "populated 1" in events.read_text()
            except FileNotFoundError:
                # error-policy:J3 The manager has already removed this stopped cgroup.
                populated = False
            if not populated:
                return
        time.sleep(0.02)
    raise RuntimeError(f"owned unit did not become empty (signal status={result.returncode})")


def native_attestation_module():
    source = pathlib.Path(__file__).with_name("stability-native-attestation.py")
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise RuntimeError("native attestation helper is not immutable root-owned source")
    specification = importlib.util.spec_from_file_location("stability_native_attestation", source)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def cleanup_resources(journal, script):
    with cleanup_budget(journal):
        cleanup_resources_bounded(journal, script)


def cleanup_resources_bounded(journal, script):
    """Complete the existing resource owner before signing, without disposing its key."""
    names = unit_names(journal.nonce)
    stop_owned_unit(names["payload"], time.monotonic() + 10)
    stop_owned_unit(names["collector"], time.monotonic() + 10)
    # Hold the allocator/release lock across every UID-based destructive action.
    # An immutable release record makes retries no-ops even if interruption
    # preceded resource-cleanup-verified; never inspect or act on its reused UID.
    with identity_admission_lock():
        identity, released = retained_identity(journal)
        if identity is not None and not released:
            validate_reserved_identity(identity)
            restore_state(journal.directory)
            state = journal.directory / "shell-state"
            if state.exists():
                command(["/bin/bash", script, "owner-cleanup", str(journal.directory), str(_cleanup_deadline)], timeout=cleanup_remaining())
            release_identity_locked(journal, identity)
        journal.append("resource-cleanup-verified", {"identityReleased": True, "ownedUnitsQuiesced": True})


def cleanup(directory, script):
    with cleanup_budget(Journal(directory)):
        cleanup_bounded(directory, script)


def cleanup_bounded(directory, script):
    journal = Journal(directory)
    names = unit_names(journal.nonce)
    journal.append("cleanup-started", {"managerInvoked": True})
    try:
        cleanup_resources(journal, script)
        if any(row["event"] == "native-key-intent" for row in journal.read()):
            cleanup_remaining()
            native_attestation_module().dispose_key(journal)
        journal.append("cleanup-verified", {"identityMayRelease": True})
    except BaseException as error:
        # Key disposal is independent of unrelated resource-cleanup success.
        # Key disposal uses the same remaining budget. Exhaustion retains the
        # root-only authority and unaccepted run for explicit owned recovery.
        try:
            if any(row["event"] == "native-key-intent" for row in journal.read()):
                cleanup_remaining()
                native_attestation_module().dispose_key(journal)
        except BaseException as key_error:
            # error-policy:J2 Preserve both cleanup failures, with no accepted terminal.
            error = BaseExceptionGroup("resource and native key cleanup failed", [error, key_error])
        # error-policy:J2 Retain root-owned journal/reservation when cleanup cannot be verified.
        try:
            journal.append("cleanup-failed", {"type": type(error).__name__, "message": str(error)})
        except BaseException as record_error:
            # error-policy:J2 Failed failure-recording preserves both causes and all reservations.
            raise BaseExceptionGroup("ownership cleanup and failure recording failed", [error, record_error])
        raise error


def channel_receive(connection, controller_pid):
    pid, uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if pid != controller_pid or uid != 0:
        raise RuntimeError("owner channel peer is not the admitted controller")
    payload, ancillary, flags, _address = connection.recvmsg(4096, socket.CMSG_SPACE(2 * array.array("i").itemsize), socket.MSG_CMSG_CLOEXEC)
    descriptors = []
    try:
        unexpected_ancillary = False
        for level, kind, data in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array("i")
                values.frombytes(data)
                descriptors.extend(values)
            else:
                unexpected_ancillary = True
        # recvmsg has already installed every returned right. Collect all of them
        # before rejecting another ancillary record so rejection closes each one.
        if unexpected_ancillary:
            raise RuntimeError("unexpected owner channel ancillary record")
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise RuntimeError("owner channel admission is truncated")
        expected = json.loads(payload)
        if len(descriptors) != 2 or len(expected) != 2:
            raise RuntimeError("owner channel requires exactly two FIFO descriptors")
        for index, fd in enumerate(descriptors):
            os.set_inheritable(fd, False)
            info = os.fstat(fd)
            actual = {"dev": info.st_dev, "ino": info.st_ino, "mode": info.st_mode, "rdev": info.st_rdev, "uid": info.st_uid, "access": fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE}
            if expected[index] != actual or actual["access"] != os.O_WRONLY:
                raise RuntimeError("owner channel descriptor differs from admitted controller identity")
            null = stat.S_ISCHR(info.st_mode) and info.st_rdev == os.makedev(1, 3)
            if not stat.S_ISFIFO(info.st_mode) and not null:
                raise RuntimeError("owner channel descriptor is not admitted FIFO/null")
        return descriptors
    except BaseException:
        # error-policy:J6 Every received descriptor remains owned until admission succeeds.
        for fd in descriptors:
            os.close(fd)
        raise


def check_lifetime(poller, controller, upstream, connection, collector=None, adapter=None):
    for fd, event in poller.poll(100):
        if fd in (controller, upstream):
            raise RuntimeError("owned controller lifetime ended")
        if collector is not None and fd == collector:
            raise RuntimeError("owned collector lifetime ended")
        if fd == connection.fileno():
            # After admission this is exclusively a lifetime channel, not input.
            if event & select.POLLHUP or connection.recv(1) == b"":
                raise RuntimeError("exclusive owner lifetime channel closed")
            raise RuntimeError("unexpected owner lifetime channel data")
        if adapter is not None and fd in adapter:
            raise RuntimeError("native outer adapter lifetime or channel ended")


def process_identity(pid):
    root = pathlib.Path("/proc") / str(pid)
    status = (root / "stat").read_text().rpartition(") ")[2].split()
    return {"pid": pid, "uid": root.stat().st_uid, "startTicks": int(status[19])}


def bind_process(identity):
    if not isinstance(identity, dict) or type(identity.get("pid")) is not int or identity["pid"] <= 1:
        raise RuntimeError("invalid original process identity")
    fd = os.pidfd_open(identity["pid"])
    try:
        if process_identity(identity["pid"]) != identity:
            raise RuntimeError("original process identity changed before pidfd binding")
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        if poller.poll(0):
            raise RuntimeError("original process has already exited")
        return fd
    except BaseException:
        # error-policy:J6 Rejected original-process authority is never retained.
        os.close(fd)
        raise


def start_lifecycle_collector(journal, names):
    # This process exercises only manager ownership. Native admission never calls
    # this fixture and must supply the authenticated observer in its own slice.
    journal.append("collector-intent", {"unit": names["collector"], "kind": "lifecycle-fixture", "nativeLedgerQualified": False})
    command([
        "/usr/bin/systemd-run", "--quiet", f"--unit={names['collector']}", "--service-type=exec",
        f"--property=BindsTo={names['guardian']}", f"--property=After={names['guardian']}",
        "--property=KillMode=control-group", "--property=Restart=no",
        "--property=StandardInput=null", "--property=StandardOutput=null", "--property=StandardError=null",
        "/bin/sleep", "300",
    ])
    group = property_value(names["collector"], "ControlGroup")
    pid = int(property_value(names["collector"], "MainPID"))
    identity = process_identity(pid)
    fd = bind_process(identity)
    try:
        if not group or pathlib.Path(f"/proc/{pid}/cgroup").read_text().strip() != "0::" + group:
            raise RuntimeError("collector identity is outside its owned cgroup")
        if property_value(names["collector"], "ActiveState") != "active" or int(property_value(names["collector"], "MainPID")) != pid or names["guardian"] not in property_value(names["collector"], "BindsTo").split() or names["guardian"] not in property_value(names["collector"], "After").split():
            raise RuntimeError("collector manager binding is not active")
        journal.append("collector-bound", {"identity": identity, "cgroup": group, "pidfdBound": True, "kind": "lifecycle-fixture"})
        return fd
    except BaseException:
        # error-policy:J6 Rejected collector authority never retains a pidfd.
        os.close(fd)
        raise


def read_root_artifact(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
            raise RuntimeError("native collector artifact is not immutable root authority")
        value = stream.read()
        after = os.fstat(stream.fileno())
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise RuntimeError("native collector artifact changed while pinned")
        return value, info


def install_native_artifact(journal, name, value, mode):
    journal.append("native-artifact-intent", {"name": name, "sha256": hashlib.sha256(value).hexdigest(), "bytes": len(value)})
    fd = os.open(journal.directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(journal.directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def socket_policy_bytes():
    """Return the single x86-64 socket-domain filter used by admission and exec."""
    filters = [
        (0x20, 0, 0, 4), (0x15, 1, 0, 0xC000003E), (0x06, 0, 0, 0x80000000),
        (0x20, 0, 0, 0), (0x45, 9, 0, 0x40000000), (0x15, 5, 0, 41), (0x15, 7, 0, 53),
        (0x15, 6, 0, 425), (0x15, 5, 0, 426), (0x15, 4, 0, 427),
        (0x06, 0, 0, 0x7FFF0000), (0x20, 0, 0, 16), (0x15, 2, 0, 2),
        (0x15, 1, 0, 10), (0x06, 0, 0, 0x00050001), (0x06, 0, 0, 0x7FFF0000),
    ]
    return b"".join(struct.pack("HBBI", *item) for item in filters)


def native_context(script, bundle):
    """Read installed authority before any attempt resources or key are allocated."""
    root = pathlib.Path(bundle)
    info = root.lstat()
    if root.resolve() != root or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("native build is not a canonical root directory")
    build, _ = read_root_artifact(root / "build.json")
    manifest = json.loads(build)
    kernel = os.uname().release
    btf = hashlib.sha256(pathlib.Path("/sys/kernel/btf/vmlinux").read_bytes()).hexdigest()
    if os.uname().machine != "x86_64" or manifest["kernel"] != kernel or manifest["btfSha256"] != btf:
        raise RuntimeError("native build does not match the current kernel")
    source_root = pathlib.Path(script).parent
    guardian, _ = read_root_artifact(source_root / "stability-sandbox-owner.py")
    signer, _ = read_root_artifact(source_root / "stability-native-attestation.py")
    launcher, _ = read_root_artifact(script)
    for name in ("ledger.h", "ledger.bpf.c", "retirement.h", "retirement.bpf.c", "collector.c"):
        value, _ = read_root_artifact(source_root / "native-ledger" / name)
        if hashlib.sha256(value).hexdigest() != manifest["sources"][name]:
            raise RuntimeError("native build source differs from installed authority")
    for name in ("collector", "ledger.bpf.o", "retirement.bpf.o"):
        value, _ = read_root_artifact(root / name)
        if hashlib.sha256(value).hexdigest() != manifest["artifacts"][name]:
            raise RuntimeError("native build artifact differs from installed authority")
    return {
        "buildSha256": hashlib.sha256(build).hexdigest(), "btfSha256": btf,
        "kernelRelease": kernel, "policySha256": hashlib.sha256(socket_policy_bytes()).hexdigest(),
        "guardianSha256": hashlib.sha256(guardian).hexdigest(), "signerSha256": hashlib.sha256(signer).hexdigest(),
        "launcherSha256": hashlib.sha256(launcher).hexdigest(),
        "nativeSourcesSha256": hashlib.sha256(canonical(manifest["sources"])).hexdigest(),
    }


def prepare_native_collector(journal, script, bundle):
    root = pathlib.Path(bundle)
    info = root.lstat()
    if root.resolve() != root or not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("native collector build is not a private canonical root directory")
    manifest_bytes, _ = read_root_artifact(root / "build.json")
    manifest = json.loads(manifest_bytes)
    if manifest["kernel"] != os.uname().release or os.uname().machine != "x86_64":
        raise RuntimeError("native collector kernel/architecture differs from its build")
    if manifest["btfSha256"] != hashlib.sha256(pathlib.Path("/sys/kernel/btf/vmlinux").read_bytes()).hexdigest():
        raise RuntimeError("native collector BTF differs from its build")
    install_native_artifact(journal, "native-build.json", manifest_bytes, 0o400)
    source_root = pathlib.Path(script).parent / "native-ledger"
    for name in ("ledger.h", "ledger.bpf.c", "retirement.h", "retirement.bpf.c", "collector.c"):
        value = (source_root / name).read_bytes()
        if hashlib.sha256(value).hexdigest() != manifest["sources"][name]:
            raise RuntimeError("native collector source differs from its build")
    for name in ("collector", "ledger.bpf.o", "retirement.bpf.o"):
        value, _ = read_root_artifact(root / name)
        if hashlib.sha256(value).hexdigest() != manifest["artifacts"][name]:
            raise RuntimeError("native collector artifact differs from its build")
        install_native_artifact(journal, name, value, 0o500 if name == "collector" else 0o400)
    records = journal.read()
    identity = next(record["data"] for record in records if record["event"] == "identity-intent")
    execution = next(record["data"]["execution"] for record in records if record["event"] == "execution-intent")
    policy, policy_info = read_root_artifact(execution["policy"])
    if len(policy) != 128 or hashlib.sha256(policy).hexdigest() != execution["policySha256"] or (policy_info.st_dev, policy_info.st_ino) != (execution["policyDev"], execution["policyIno"]):
        raise RuntimeError("native collector policy differs from admitted execution")
    _bytes, bwrap = read_root_artifact("/usr/bin/bwrap")
    _bytes, runtime = read_root_artifact(pathlib.Path(execution["policy"]).parent / "runtime")
    def kernel_device(device):
        return (os.major(device) << 20) | os.minor(device)
    configuration = struct.pack("<II", identity["uid"], 16) + policy + struct.pack("<QQQQ", kernel_device(bwrap.st_dev), bwrap.st_ino, kernel_device(runtime.st_dev), runtime.st_ino)
    install_native_artifact(journal, "native-config.bin", configuration, 0o600)
    journal.append("native-build-bound", {"manifest": manifest, "configurationSha256": hashlib.sha256(configuration).hexdigest(), "policySha256": execution["policySha256"]})
    binary = root / "collector"
    value, info = read_root_artifact(binary)
    if not os.access(binary, os.X_OK):
        raise RuntimeError("verified native collector is not on an executable filesystem")
    journal.append("native-executable-bound", {"path": str(binary), "dev": info.st_dev, "ino": info.st_ino, "sha256": hashlib.sha256(value).hexdigest()})


def native_executable(journal):
    admitted = next(record["data"] for record in journal.read() if record["event"] == "native-executable-bound")
    value, info = read_root_artifact(admitted["path"])
    if (info.st_dev, info.st_ino) != (admitted["dev"], admitted["ino"]) or hashlib.sha256(value).hexdigest() != admitted["sha256"]:
        raise RuntimeError("native collector executable changed after admission")
    return admitted["path"]


def start_native_collector(journal, names, script, bundle, poller, controller, upstream, connection, adapter=None, attempt_deadline=None):
    prepare_native_collector(journal, script, bundle)
    binary = native_executable(journal)
    original = process_identity(os.getpid())
    log = os.open(journal.directory / "collector.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(log)
    journal.append("collector-intent", {"unit": names["collector"], "kind": "native-producer", "nativeLedgerQualified": False})
    command([
        "/usr/bin/systemd-run", "--quiet", f"--unit={names['collector']}", "--service-type=exec",
        f"--property=BindsTo={names['guardian']}", f"--property=After={names['guardian']}",
        "--property=KillMode=control-group", "--property=Restart=no", "--property=RemainAfterExit=yes", "--property=TimeoutStopSec=10",
        "--property=StandardInput=null", "--property=StandardOutput=null", f"--property=StandardError=append:{journal.directory / 'collector.log'}",
        binary, str(journal.directory), str(original["pid"]), str(original["startTicks"]), str(max(1, int(remaining_external_deadline(attempt_deadline) * 1000))),
    ])
    pid = int(property_value(names["collector"], "MainPID"))
    identity = process_identity(pid)
    fd = bind_process(identity)
    channel = None
    try:
        group = property_value(names["collector"], "ControlGroup")
        if not group or pathlib.Path(f"/proc/{pid}/cgroup").read_text().strip() != "0::" + group or names["guardian"] not in property_value(names["collector"], "BindsTo").split() or names["guardian"] not in property_value(names["collector"], "After").split():
            raise RuntimeError("native collector is outside its bound manager scope")
        deadline = time.monotonic() + 15
        while not (journal.directory / "collector.sock").exists():
            if time.monotonic() >= deadline:
                raise RuntimeError("native collector channel readiness expired")
            check_lifetime(poller, controller, upstream, connection, fd, adapter)
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        channel.settimeout(1)
        channel.connect(str(journal.directory / "collector.sock"))
        peer_pid, peer_uid, _gid = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if peer_uid != 0 or peer_pid != pid or process_identity(pid) != identity:
            raise RuntimeError("native collector channel changed authority")
        channel.setblocking(False)
        poller.register(fd, select.POLLIN)
        while not select.select([channel], [], [], 0)[0]:
            if time.monotonic() >= deadline:
                raise RuntimeError("native collector hook readiness expired")
            check_lifetime(poller, controller, upstream, connection, fd, adapter)
        if channel.recv(4096) != b"READY\n":
            raise RuntimeError("native collector did not admit its mandatory hooks")
        check_lifetime(poller, controller, upstream, connection, fd, adapter)
        inventories = {}
        for name in ("native-producer-ids.txt", "native-monitor-ids.txt"):
            value, _ = read_root_artifact(journal.directory / name)
            inventories[name] = hashlib.sha256(value).hexdigest()
        journal.append("collector-bound", {"identity": identity, "cgroup": group, "pidfdBound": True, "kind": "native-producer", "inventories": inventories})
        return fd, channel, inventories
    except BaseException:
        # error-policy:J6 The manager retains service cleanup; rejected local handles close here.
        if channel is not None:
            channel.close()
        os.close(fd)
        raise


def finish_native_collector(journal, names, collector, channel, inventories, lifetime, controller, upstream, connection, adapter=None):
    stop_owned_unit(names["payload"], time.monotonic() + 10)
    journal.append("native-producers-quiesced", {"payloadUnit": names["payload"]})
    deadline = time.monotonic() + 30
    if channel.send(b"SEAL\n") != 5:
        raise RuntimeError("native collector seal request was incomplete")
    exited = select.poll()
    exited.register(collector, select.POLLIN)
    while not select.select([channel], [], [], 0)[0]:
        if time.monotonic() >= deadline or (exited.poll(0) and not select.select([channel], [], [], 0)[0]):
            raise RuntimeError("native collector ended before a completed drain")
        check_lifetime(lifetime, controller, upstream, connection, adapter=adapter)
    if channel.recv(4096) != b"DRAINED\n":
        raise RuntimeError("native collector did not complete its quiescent drain")
    deadline = time.monotonic() + 10
    while not exited.poll(0):
        if time.monotonic() >= deadline:
            raise RuntimeError("native collector did not terminate after drain")
        check_lifetime(lifetime, controller, upstream, connection, adapter=adapter)
    if property_value(names["collector"], "ExecMainCode") != "1" or property_value(names["collector"], "ExecMainStatus") != "0" or property_value(names["collector"], "Result") != "success":
        raise RuntimeError("native collector exited unsuccessfully after drain")
    for name, expected in inventories.items():
        value, _ = read_root_artifact(journal.directory / name)
        if hashlib.sha256(value).hexdigest() != expected:
            raise RuntimeError("native collector ownership inventory changed")
        deadline = time.monotonic() + 10
        while True:
            result = subprocess.run([native_executable(journal), "--verify-gone", str(journal.directory / name)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
            if result.returncode == 0:
                break
            if result.returncode != 3 or time.monotonic() >= deadline:
                raise RuntimeError("native collector retained or lost track of an owned BPF object")
            time.sleep(0.05)
    summary_bytes, _ = read_root_artifact(journal.directory / "native-drain.json")
    records, _ = read_root_artifact(journal.directory / "native-events.jsonl")
    summary = json.loads(summary_bytes)
    if summary["nativeManifestAuthenticated"] is not False or summary["bytes"] != len(records):
        raise RuntimeError("native collector drain summary differs from its records")
    journal.append("native-drained", {"summary": summary, "sha256": hashlib.sha256(records).hexdigest(), "summarySha256": hashlib.sha256(summary_bytes).hexdigest(), "ownedBpfObjectsGone": True, "nativeLedgerQualified": False})


def build_native_manifest(journal, request, script, lifecycle_fixture):
    """Bind root artifacts after native drain and resource cleanup, before key disposal."""
    if lifecycle_fixture:
        raise RuntimeError("lifecycle fixtures cannot receive native signatures")
    with journal.locked():
        history = journal._read()
        journal_bytes, _ = read_root_artifact(journal.path)
    if any(row["event"] in ("owner-failed", "cleanup-failed", "native-admission-unavailable") for row in history):
        raise RuntimeError("failed native attempt cannot receive a signature")
    def event(name):
        matches = [row for row in history if row["event"] == name]
        if len(matches) != 1:
            raise RuntimeError("native signing lifecycle event is missing or ambiguous: " + name)
        return matches[0]
    exited = event("payload-exited")
    quiesced = event("native-producers-quiesced")
    drained = event("native-drained")
    released = event("identity-released")
    cleaned = event("resource-cleanup-verified")
    positions = [history.index(row) for row in (exited, quiesced, drained, released, cleaned)]
    if positions != sorted(positions) or exited["data"]["code"] != 0 or drained["data"]["ownedBpfObjectsGone"] is not True:
        raise RuntimeError("native resource lifecycle did not complete in order")
    if cleaned["data"] != {"identityReleased": True, "ownedUnitsQuiesced": True}:
        raise RuntimeError("native resource cleanup was not verified")
    bound = event("native-build-bound")["data"]
    artifacts = {}
    for name in ("native-events.jsonl", "native-counters.json", "native-drain.json", "native-producer-ids.txt", "native-monitor-ids.txt", "native-build.json"):
        artifacts[name], _ = read_root_artifact(journal.directory / name)
    def digest(value):
        return hashlib.sha256(value).hexdigest()
    ledger = artifacts["native-events.jsonl"]
    if not ledger.endswith(b"\n"):
        raise RuntimeError("native ledger is incomplete")
    rows = [json.loads(line) for line in ledger.splitlines()]
    numeric = {"sequence", "monotonicNs", "thread", "socketId", "kind", "nr", "result", "family", "port", "flags", "captured", "operation", "taskStartNs", "parentStartNs", "parentTgid", "namespaceId", "namespacePid", "parentNamespacePid"}
    for row in rows:
        if set(row) != numeric | {"address"} or any(type(row[name]) is not int or abs(row[name]) > 9007199254740991 or (name != "result" and row[name] < 0) for name in numeric):
            raise RuntimeError("native kernel record has unsupported numeric shape")
        if not 1 <= row["kind"] <= 25 or not isinstance(row["address"], list) or len(row["address"]) != 4 or any(type(word) is not int or not 0 <= word <= 4294967295 for word in row["address"]):
            raise RuntimeError("native kernel record has unsupported event/address")
    sequence = {row["sequence"] for row in rows}
    if not rows or len(sequence) != len(rows) or sequence != set(range(1, len(rows) + 1)):
        raise RuntimeError("native ledger sequence has loss or duplicates")
    calls = {"network": {}, "filter": {}}
    entries = exits = 0
    for row in sorted(rows, key=lambda row: row["sequence"]):
        kind = row["kind"]
        if kind not in (1, 2, 22, 24, 25):
            continue
        pending = calls["network" if kind <= 2 else "filter"]
        thread = row["thread"]
        if not thread:
            raise RuntimeError("native syscall has no thread identity")
        if kind in (1, 22, 24):
            if thread in pending:
                raise RuntimeError("native syscall entries overlap")
            pending[thread] = row
            entries += kind == 1
        else:
            initial = pending.pop(thread, None)
            if initial is None or initial["nr"] != row["nr"] or initial["monotonicNs"] > row["monotonicNs"] or (kind == 25 and (initial["operation"], initial["flags"]) != (row["operation"], row["flags"])):
                raise RuntimeError("native syscall outcome is unmatched")
            exits += kind == 2
    if any(calls.values()) or entries != exits:
        raise RuntimeError("native syscall outcomes are incomplete")
    counters = json.loads(artifacts["native-counters.json"])
    failures = {"ringLoss", "socketCreateFailure", "socketReadFailure", "socketDeleteFailure", "kernelReadFailure", "unsupportedFilterChange", "filterStateCreateFailure", "filterStateReadFailure", "filterStateDeleteFailure", "syscallStateCreateFailure", "syscallStateReadFailure", "syscallStateDeleteFailure", "bootstrapRoleFailure", "bootstrapNetworkFailure"}
    expected_counters = {name: 0 for name in failures}
    expected_counters.update({"emitted": len(rows), "received": len(rows), "syscallEntries": entries, "syscallExits": exits, "nativeManifestAuthenticated": False})
    if any(type(counters.get(name)) is not int for name in expected_counters if name != "nativeManifestAuthenticated") or counters.get("nativeManifestAuthenticated") is not False or counters != expected_counters:
        raise RuntimeError("native observer counters are not complete and fault-free")
    summary = json.loads(artifacts["native-drain.json"])
    if any(type(summary.get(name)) is not int for name in ("schema", "records", "bytes", "syscallEntries", "syscallExits")) or summary.get("nativeManifestAuthenticated") is not False or summary != {"schema": 1, "records": len(rows), "bytes": len(ledger), "syscallEntries": entries, "syscallExits": exits, "nativeManifestAuthenticated": False}:
        raise RuntimeError("native drain differs from complete records")
    if digest(ledger) != drained["data"]["sha256"] or digest(artifacts["native-drain.json"]) != drained["data"]["summarySha256"]:
        raise RuntimeError("native drain artifacts changed after collector completion")
    build = json.loads(artifacts["native-build.json"])
    if build != bound["manifest"]:
        raise RuntimeError("native retained build differs from admitted source")
    guardian_bytes, _ = read_root_artifact(__file__)
    signer_bytes, _ = read_root_artifact(pathlib.Path(script).parent / "stability-native-attestation.py")
    identities = {
        "buildSha256": digest(artifacts["native-build.json"]), "policySha256": bound["policySha256"],
        "btfSha256": build["btfSha256"], "kernelRelease": build["kernel"],
        "guardianSha256": digest(guardian_bytes), "signerSha256": digest(signer_bytes),
    }
    if any(request["context"].get(name) != value for name, value in identities.items()):
        raise RuntimeError("native signer source differs from outer admission")
    manifest = {
        "schema": "eliza.stability.native.v1", "nonce": request["nonce"], "context": request["context"],
        "nativeLedgerQualified": True, "cleanupVerified": True,
        "ledgerSha256": digest(ledger), "journalSha256": digest(journal_bytes),
        "countersSha256": digest(artifacts["native-counters.json"]), "drainSha256": digest(artifacts["native-drain.json"]),
        "producerInventorySha256": digest(artifacts["native-producer-ids.txt"]),
        "monitorInventorySha256": digest(artifacts["native-monitor-ids.txt"]),
        "ledgerBytes": len(ledger), "ledgerRecords": len(rows), "producerQuiesced": True,
        "collectorExitCode": 0, "ownedBpfObjectsGone": True, "completionProof": "source-enforced-v1", **identities,
    }
    # The immutable prefix ends at verified resource cleanup. Later key disposal
    # is a separate terminal fact delivered only over the retained owned channel.
    install_native_artifact(journal, "native-signed-journal.jsonl", journal_bytes, 0o400)
    return manifest


def finish_authenticated_native(journal, authentication, script):
    with cleanup_budget(journal):
        return finish_authenticated_native_bounded(journal, authentication, script)


def finish_authenticated_native_bounded(journal, authentication, script):
    """Persist complete signed bytes before key disposal and terminal acceptance."""
    authentication.assert_alive()
    cleanup_resources(journal, script)
    authentication.assert_alive()
    manifest = build_native_manifest(journal, authentication.request, script, False)
    attestation = authentication.sign(manifest)
    names = {
        "ledger.jsonl": "native-events.jsonl", "journal.jsonl": "native-signed-journal.jsonl",
        "counters.json": "native-counters.json", "drain.json": "native-drain.json",
        "producer-ids.txt": "native-producer-ids.txt", "monitor-ids.txt": "native-monitor-ids.txt",
        "build.json": "native-build.json",
    }
    artifacts = {name: read_root_artifact(journal.directory / source)[0] for name, source in names.items()}
    authentication.persist_artifacts(attestation, artifacts)
    authentication.dispose()
    journal.append("native-terminal-ready", {"attestationSha256": hashlib.sha256(native_attestation_module().canonical(attestation)).hexdigest()})
    authentication.accept_after_disposal(attestation)
    return attestation


def guardian(directory, controller_identity, upstream_identity, script, arguments, lifecycle_fixture=False, native_bundle=None, auth_request=None, attempt_deadline=None):
    attempt_timeout = selected_attempt_timeout(auth_request)
    journal = Journal(directory)
    names = unit_names(journal.nonce)
    if attempt_deadline is None:
        attempt_deadline = time.monotonic() + attempt_timeout / 1000
    controller_pid = controller_identity["pid"]
    journal.append("owner-started", {"units": names, "controllerIdentity": controller_identity, "upstreamIdentity": upstream_identity, "attemptTimeoutMs": attempt_timeout, "activeDeadline": attempt_deadline})
    controller = bind_process(controller_identity)
    try:
        upstream = bind_process(upstream_identity)
    except BaseException:
        # error-policy:J6 Failure before channel setup still releases the first pidfd.
        os.close(controller)
        raise
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    listener.bind(str(journal.directory / "control.sock"))
    os.chmod(journal.directory / "control.sock", 0o600)
    listener.listen(1)
    journal.append("guardian-listening", {"socketListening": True})
    connection = None
    descriptors = []
    collector = None
    native_channel = None
    native_inventories = None
    authentication = None
    adapter = None
    try:
        poller = select.poll()
        for fd in (controller, upstream):
            poller.register(fd, select.POLLIN)
        poller.register(listener.fileno(), select.POLLIN)
        events = poller.poll(10_000)
        if not events or any(fd in (controller, upstream) for fd, _event in events):
            raise RuntimeError("owner channel was not admitted before controller death/deadline")
        connection, _ = listener.accept()
        connection.settimeout(5)
        descriptors = channel_receive(connection, controller_pid)
        poller.unregister(listener.fileno())
        listener.close()
        poller.register(connection.fileno(), select.POLLIN | select.POLLHUP)
        journal.append("controller-bound", {"pidfdBound": True, "exclusiveChannel": True})
        if auth_request is not None:
            authentication = native_attestation_module().NativeAttestationChannel(journal, auth_request)
            authentication.establish()
            adapter = (authentication.pidfd, authentication.connection.fileno())
            for fd in adapter:
                poller.register(fd, select.POLLIN | select.POLLHUP)

        log = os.open(journal.directory / "prepare.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            prepared = subprocess.Popen(["/bin/bash", script, "owner-prepare", str(journal.directory), str(attempt_deadline), *arguments], stdin=subprocess.DEVNULL, stdout=log, stderr=log, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
            preparation_deadline = attempt_deadline
            while prepared.poll() is None:
                if time.monotonic() >= preparation_deadline:
                    raise RuntimeError("sandbox preparation deadline expired")
                check_lifetime(poller, controller, upstream, connection, collector, adapter)
        finally:
            os.close(log)
        if prepared.returncode != 0:
            raise RuntimeError("sandbox resource preparation failed")
        if not lifecycle_fixture:
            if not NATIVE_SIGNING_ENABLED or authentication is None or native_bundle is None:
                journal.append("native-admission-unavailable", {"code": "STABILITY_NATIVE_LEDGER_UNAVAILABLE"})
                raise RuntimeError("native observer and signed manifest admission are not yet available")
            journal.append("native-admitted", {"contextSha256": authentication.context_hash})
        if native_bundle is None:
            collector = start_lifecycle_collector(journal, names)
        else:
            collector, native_channel, native_inventories = start_native_collector(journal, names, script, native_bundle, poller, controller, upstream, connection, adapter, attempt_deadline)
        poller.register(collector, select.POLLIN)
        check_lifetime(poller, controller, upstream, connection, collector, adapter)
        journal.append("payload-intent", {"unit": names["payload"]})
        payload = subprocess.Popen([
            "/usr/bin/systemd-run", "--quiet", "--scope", f"--unit={names['payload']}",
            f"--property=BindsTo={names['guardian']}", f"--property=After={names['guardian']}",
            "--property=Delegate=no", "/bin/bash", script, "owner-execute", str(journal.directory),
        ], stdin=subprocess.DEVNULL, stdout=descriptors[0], stderr=descriptors[1], close_fds=True, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        for fd in descriptors:
            os.close(fd)
        descriptors = []
        ready = journal.directory / "payload-ready"
        ready_deadline = min(time.monotonic() + 10, attempt_deadline)
        while not ready.exists() and payload.poll() is None:
            if time.monotonic() >= ready_deadline:
                raise RuntimeError("payload scope readiness deadline expired")
            check_lifetime(poller, controller, upstream, connection, collector, adapter)
        if not ready.exists():
            raise RuntimeError("payload scope exited before its readiness barrier")
        actual_group = property_value(names["payload"], "ControlGroup")
        if not actual_group or property_value(names["payload"], "ActiveState") != "active" or names["guardian"] not in property_value(names["payload"], "BindsTo").split() or names["guardian"] not in property_value(names["payload"], "After").split():
            raise RuntimeError("payload scope binding is not active")
        ready_identity = json.loads(ready.read_bytes())
        if ready_identity["cgroup"] != actual_group:
            raise RuntimeError("payload readiness is outside the bound scope")
        check_lifetime(poller, controller, upstream, connection, collector, adapter)
        journal.append("ownership-ready", {"payloadPid": payload.pid, "cgroup": actual_group, "nativeLedgerQualified": False})
        connection.send(b"OWNERSHIP_READY")
        release = "release-lifecycle-fixture" if lifecycle_fixture else "release-native"
        (journal.directory / release).write_bytes(b"owned-guardian-release")
        deadline = attempt_deadline
        while payload.poll() is None:
            if time.monotonic() >= deadline:
                raise RuntimeError("owned payload lifetime deadline expired")
            check_lifetime(poller, controller, upstream, connection, collector, adapter)
        check_lifetime(poller, controller, upstream, connection, collector, adapter)
        # Lifecycle exit is not a seal. Native integration must additionally
        # quiesce producers and validate final observer counters before signing.
        journal.append("payload-exited", {"code": payload.returncode})
        if native_channel is not None:
            finish_native_collector(journal, names, collector, native_channel, native_inventories, poller, controller, upstream, connection, adapter)
        if lifecycle_fixture:
            connection.send(canonical({"lifecycleCode": payload.returncode, "nativeLedgerQualified": False}))
        else:
            attestation = finish_authenticated_native(journal, authentication, script)
            connection.send(canonical({"lifecycleCode": payload.returncode, "nativeLedgerQualified": True, "nativeAttestationSha256": hashlib.sha256(native_attestation_module().canonical(attestation)).hexdigest()}))
    finally:
        if connection is not None:
            connection.close()
        listener.close()
        for fd in descriptors:
            os.close(fd)
        if native_channel is not None:
            native_channel.close()
        if collector is not None:
            os.close(collector)
        if authentication is not None:
            authentication.close()
        os.close(controller)
        os.close(upstream)


def systemd_quote(value):
    if "\n" in value or "\0" in value:
        raise RuntimeError("unit command contains an unsupported control character")
    return '"' + value.replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"') + '"'


def descriptor_identity(fd):
    info = os.fstat(fd)
    return {"dev": info.st_dev, "ino": info.st_ino, "mode": info.st_mode, "rdev": info.st_rdev, "uid": info.st_uid, "access": fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE}


def controller(script, arguments, upstream_identity, lifecycle_fixture=False, native_bundle=None, auth_request=None):
    attempt_timeout = selected_attempt_timeout(auth_request)
    attempt_deadline = time.monotonic() + attempt_timeout / 1000
    nonce = uuid.uuid4().hex
    names = unit_names(nonce)
    directory = pathlib.Path("/run") / (PREFIX + nonce)
    executable = str(pathlib.Path(__file__).resolve())
    original = process_identity(os.getpid())
    upstream = bind_process(upstream_identity)
    connection = None
    service_attempted = False
    terminal = None
    try:
        stop = " ".join(systemd_quote(item) for item in ["/usr/bin/python3", "-I", "-S", executable, "cleanup", str(directory), script])
        # A timed-out manager request has an uncertain creation outcome. The unique
        # unit remains ours to inspect and stop even without a successful reply.
        service_attempted = True
        command([
            "/usr/bin/systemd-run", "--quiet", f"--unit={names['guardian']}", "--service-type=exec",
            f"--property=RuntimeDirectory={PREFIX}{nonce}", "--property=RuntimeDirectoryMode=0700",
            "--property=RuntimeDirectoryPreserve=yes", "--property=KillMode=control-group",
            f"--property=TimeoutStopSec={attempt_timeout / 1000 + 5}", f"--property=ExecStopPost={stop}",
            "--property=StandardInput=null", "--property=StandardOutput=null", "--property=StandardError=null",
            "/usr/bin/python3", "-I", "-S", executable, "guardian", str(directory),
            json.dumps(original), json.dumps(upstream_identity), script, json.dumps(arguments),
            "fixture" if lifecycle_fixture else "native", json.dumps(native_bundle), json.dumps(auth_request), str(attempt_deadline),
        ], timeout=10)
        deadline = time.monotonic() + 10
        poller = select.poll()
        poller.register(upstream, select.POLLIN)
        # bind creates the path before listen. The root journal records actual
        # listening readiness; path existence alone is not admission.
        while not (directory / "control.sock").exists() or not any(row["event"] == "guardian-listening" for row in Journal(directory).read()):
            if poller.poll(20) or time.monotonic() >= deadline:
                raise RuntimeError("guardian startup ended before channel readiness")
            if property_value(names["guardian"], "ActiveState") in ("inactive", "failed"):
                raise RuntimeError("guardian service exited before readiness")
        private_directory(directory)
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        connection.settimeout(5)
        connection.connect(str(directory / "control.sock"))
        guardian_pid = int(property_value(names["guardian"], "MainPID"))
        peer_pid, peer_uid, _gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if peer_uid != 0 or peer_pid != guardian_pid:
            raise RuntimeError("owner channel peer is not the manager's guardian")
        descriptors = array.array("i", [1, 2])
        connection.sendmsg([canonical([descriptor_identity(1), descriptor_identity(2)])], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
        connection.setblocking(False)
        poller.register(connection.fileno(), select.POLLIN | select.POLLHUP)
        deadline = attempt_deadline
        while terminal is None:
            if time.monotonic() >= deadline:
                raise RuntimeError("guardian response deadline expired")
            for fd, event in poller.poll(100):
                if fd == upstream:
                    raise RuntimeError("original upstream controller exited")
                if fd == connection.fileno():
                    payload = connection.recv(4096)
                    if not payload:
                        records = Journal(directory).read()
                        if any(record["event"] == "native-admission-unavailable" for record in records):
                            raise RuntimeError("native observer and signed manifest admission are not yet available")
                        raise RuntimeError("guardian channel ended without a terminal record")
                    if payload == b"OWNERSHIP_READY":
                        continue
                    terminal = json.loads(payload)
        return {"directory": str(directory), "units": names, "terminal": terminal}
    finally:
        if connection is not None:
            connection.close()
        os.close(upstream)
        if service_attempted:
            primary = sys.exception()
            try:
                # The manager owns ExecStopPost; an unsuccessful stop is never
                # interpreted as verified cleanup, even after payload exit.
                if property_value(names["guardian"], "LoadState") != "not-found":
                    command(["/usr/bin/systemctl", "stop", names["guardian"]], timeout=attempt_timeout / 1000 + 10)
                    records = Journal(directory).read()
                    if not records or records[-1]["event"] != "cleanup-verified":
                        raise RuntimeError("guardian stopped without verified resource cleanup")
                elif directory.exists():
                    raise RuntimeError("manager lost its unit while ownership journal remains")
            except BaseException as cleanup_error:
                # error-policy:J2 Teardown cannot replace or disguise the primary admission error.
                if primary is not None:
                    raise BaseExceptionGroup("owner operation and manager cleanup failed", [primary, cleanup_error])
                raise


def create_sandbox_root(journal):
    target = pathlib.Path("/var/tmp") / ("eliza-stability-sandbox." + journal.nonce)
    if target.exists() or target.is_symlink():
        raise RuntimeError("sandbox root candidate already exists")
    journal.append("root-intent", {"path": str(target)})
    target.mkdir(mode=0o700)
    info = target.lstat()
    journal.append("root-created", {"path": str(target), "dev": info.st_dev, "ino": info.st_ino})


def remove_sandbox_root(journal):
    target = pathlib.Path("/var/tmp") / ("eliza-stability-sandbox." + journal.nonce)
    if not target.exists() and not target.is_symlink():
        return
    records = journal.read()
    if not any(record["event"] == "root-intent" and record["data"]["path"] == str(target) for record in records):
        raise RuntimeError("sandbox root has no owned allocation intent")
    identity = next(record["data"] for record in records if record["event"] == "identity-intent")
    info = target.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, identity["uid"]):
        raise RuntimeError("sandbox root ownership changed before removal")
    created = next((record["data"] for record in records if record["event"] == "root-created"), None)
    if created is not None and (created["dev"], created["ino"]) != (info.st_dev, info.st_ino):
        raise RuntimeError("sandbox root inode changed before removal")
    # Payload mount namespaces are already gone. A host-visible nested mount is
    # not an owned directory and must not be traversed by privileged removal.
    for line in pathlib.Path("/proc/self/mountinfo").read_text().splitlines():
        mounted = line.split(" - ", 1)[0].split()[4]
        if mounted == str(target) or mounted.startswith(str(target) + "/"):
            raise RuntimeError("sandbox root retains an unexpected host mount")
    if not shutil.rmtree.avoids_symlink_attacks:
        raise RuntimeError("descriptor-safe sandbox root removal is unavailable")
    shutil.rmtree(target)
    if target.exists() or target.is_symlink():
        raise RuntimeError("sandbox root remains after removal")
    journal.append("root-removed", {"path": str(target)})


def write_execution(journal, policy, argv):
    if not argv or any(not isinstance(item, str) or "\0" in item for item in argv):
        raise RuntimeError("complete sandbox execution arguments are invalid")
    policy_fd = os.open(policy, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(policy_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o400:
            raise RuntimeError("execution policy is not an immutable root file")
        with os.fdopen(os.dup(policy_fd), "rb") as stream:
            digest = hashlib.sha256(stream.read()).hexdigest()
    finally:
        os.close(policy_fd)
    execution = {"argv": argv, "policy": policy, "policySha256": digest, "policyDev": info.st_dev, "policyIno": info.st_ino}
    # Complete argv and policy identity are recoverable even if the materialized
    # file is interrupted. Execution requires a matching complete file.
    journal.append("execution-intent", {"execution": execution, "sha256": hashlib.sha256(canonical(execution)).hexdigest()})
    target = journal.directory / "execution.json"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(canonical(execution))
        output.flush()
        os.fsync(output.fileno())


def payload_exec(directory):
    journal = Journal(directory)
    records = journal.read()
    intent = next(record["data"] for record in records if record["event"] == "execution-intent")
    fd = os.open(journal.directory / "execution.json", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("execution record is not private root authority")
        execution = json.loads(source.read())
    if execution != intent["execution"] or hashlib.sha256(canonical(execution)).hexdigest() != intent["sha256"]:
        raise RuntimeError("execution arguments differ from durable admission intent")
    policy = os.open(execution["policy"], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(policy)
        with os.fdopen(os.dup(policy), "rb") as stream:
            digest = hashlib.sha256(stream.read()).hexdigest()
        if (info.st_dev, info.st_ino, info.st_uid, stat.S_IMODE(info.st_mode), digest) != (execution["policyDev"], execution["policyIno"], 0, 0o400, execution["policySha256"]):
            raise RuntimeError("execution policy changed before scope admission")
        os.lseek(policy, 0, os.SEEK_SET)
        payload_barrier(directory)
        if policy != 3:
            os.dup2(policy, 3)
        os.set_inheritable(3, True)
    finally:
        if policy != 3:
            os.close(policy)
    os.execv(execution["argv"][0], execution["argv"])


def transfer_recorded_output(journal, output_directory, caller_uid, cleanup_deadline=None):
    identity = next(record["data"] for record in journal.read() if record["event"] == "identity-intent")
    journal.append("output-transfer-intent", {"path": output_directory, "callerUid": caller_uid})
    try:
        receipt = transfer_output_ownership(output_directory, caller_uid, identity, deadline_seconds=remaining_external_deadline(cleanup_deadline) if cleanup_deadline is not None else 20)
    except OutputTransferError as error:
        # error-policy:J2 The durable partial receipt prevents uncertain identity release.
        journal.append("output-transfer-failed", {"transferredInodes": error.transferred_inodes, "reason": str(error)})
        raise
    journal.append("output-transferred", receipt)


def restore_state(directory):
    journal = Journal(directory)
    records = journal.read()
    intent = next((entry for entry in reversed(records) if entry["event"] == "resource-intent"), None)
    if intent is None:
        return
    state = intent["data"]["state"].encode()
    if hashlib.sha256(state).hexdigest() != intent["data"]["stateSha256"]:
        raise RuntimeError("resource intent state digest is invalid")
    target = journal.directory / "shell-state"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(state)
        output.flush()
        os.fsync(output.fileno())


def payload_barrier(directory):
    journal = Journal(directory)
    group = pathlib.Path("/proc/self/cgroup").read_text().strip()
    if not group.startswith("0::/"):
        raise RuntimeError("payload requires a unified cgroup")
    identity = {"pid": os.getpid(), "cgroup": group[3:]}
    target = journal.directory / "payload-ready"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(canonical(identity))
        output.flush()
        os.fsync(output.fileno())
    deadline = time.monotonic() + 30
    while not (journal.directory / "release-lifecycle-fixture").exists() and not (journal.directory / "release-native").exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("payload was not admitted by its guardian")
        time.sleep(0.02)


def main():
    require_root()
    mode, *args = sys.argv[1:]
    if mode == "checkpoint":
        Journal(args[0]).checkpoint(sys.stdin.buffer.read())
    elif mode == "allocate-identity":
        identity = allocate_identity(Journal(args[0]), float(args[1]) if len(args) > 1 else None)
        print(identity["name"], identity["uid"], identity["gid"])
    elif mode == "create-root":
        create_sandbox_root(Journal(args[0]))
    elif mode == "remove-root":
        remove_sandbox_root(Journal(args[0]))
    elif mode == "write-execution":
        write_execution(Journal(args[0]), args[1], args[2:])
    elif mode == "payload-exec":
        payload_exec(args[0])
    elif mode == "transfer-output":
        transfer_recorded_output(Journal(args[0]), args[1], int(args[2]), float(args[3]) if len(args) > 3 else None)
    elif mode == "write-policy":
        descriptor = os.open(args[0], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        with os.fdopen(descriptor, "wb") as output:
            output.write(socket_policy_bytes())
            output.flush()
            os.fsync(output.fileno())
    elif mode == "native-context":
        print(json.dumps(native_context(args[0], args[1])))
    elif mode == "process-identity":
        print(json.dumps(process_identity(int(args[0]))))
    elif mode == "launcher-native":
        result = controller(args[1], args[4:], json.loads(args[0]), False, args[2], json.loads(args[3]))
        if result["terminal"]["nativeLedgerQualified"] is not True or result["terminal"]["lifecycleCode"] != 0:
            raise RuntimeError("native launcher did not complete authenticated ownership")
    elif mode in ("launcher", "launcher-probe"):
        fixture = mode == "launcher-probe"
        result = controller(args[1], args[2:], json.loads(args[0]), fixture)
        if not fixture or result["terminal"]["nativeLedgerQualified"] is not False or result["terminal"]["lifecycleCode"] != 0:
            raise RuntimeError("sandbox did not produce its required admission result")
        # Only the fixed kernel setup probe uses this lifecycle-only outcome.
    elif mode == "restore-state":
        restore_state(args[0])
    elif mode == "payload-barrier":
        payload_barrier(args[0])
    elif mode == "cleanup":
        cleanup(args[0], args[1])
    elif mode == "guardian":
        try:
            guardian(args[0], json.loads(args[1]), json.loads(args[2]), args[3], json.loads(args[4]), args[5] == "fixture", json.loads(args[6]) if len(args) > 6 else None, json.loads(args[7]) if len(args) > 7 else None, float(args[8]) if len(args) > 8 else None)
        except BaseException as error:
            # error-policy:J2 Preserve the root-only admission failure before manager teardown.
            diagnostic = {"type": type(error).__name__, "reason": str(error)}
            if isinstance(error, OwnedControlError):
                diagnostic["status"] = error.status
                diagnostic["controlStderr"] = error.stderr.decode("utf-8", errors="replace")
            Journal(args[0]).append("owner-failed", diagnostic)
            raise
    elif mode == "authenticated":
        result = controller(args[0], json.loads(args[1]), json.loads(args[2]), False, args[3], json.loads(args[4]))
        print(json.dumps(result), file=sys.stderr)
        if result["terminal"]["nativeLedgerQualified"] is not True or result["terminal"]["lifecycleCode"] != 0:
            raise RuntimeError("native attempt did not complete authenticated ownership")
    elif mode == "key-channel-fixture":
        result = controller(args[0], json.loads(args[1]), json.loads(args[2]), True, args[3], json.loads(args[4]))
        print(json.dumps(result), file=sys.stderr)
        if result["terminal"]["nativeLedgerQualified"] is not False or result["terminal"]["lifecycleCode"] != 0:
            raise RuntimeError("key fixture did not finish its unsigned lifecycle")
    elif mode == "observer-fixture":
        result = controller(args[0], json.loads(args[1]), json.loads(args[2]), True, args[3])
        print(json.dumps(result), file=sys.stderr)
        if result["terminal"]["nativeLedgerQualified"] is not False or result["terminal"]["lifecycleCode"] != 0:
            raise RuntimeError("observer fixture did not finish its explicitly unqualified lifecycle")
    elif mode == "controller":
        result = controller(args[0], json.loads(args[1]), json.loads(args[2]), len(args) > 3 and args[3] == "fixture")
        # Lifecycle completion is deliberately not a native-ledger acceptance token.
        print(json.dumps(result), file=sys.stderr)
        raise RuntimeError("native observer and signed manifest admission are not yet available")
    else:
        raise RuntimeError("unknown owner command")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # error-policy:J1 Root-only process boundary reports a failed ownership/admission operation.
        print(f"[cloud-stability-owner] {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
