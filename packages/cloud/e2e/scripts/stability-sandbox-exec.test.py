"""Exercise the real descriptor barrier with owned sockets and exec consumers.

Linux controls retain descriptors above a lowered process limit, closed stdio,
and mismatched policy handles. No data is sent through a socket.
"""

import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import unittest


DRIVER = r"""
import os, resource, sys
helper, policy, policy_fd, socket_fd, mode, probe = sys.argv[1:]
# Duplication happens before lowering the limit, matching inherited capabilities.
soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
assert hard > 4096, 'fixture requires a hard descriptor limit above 4096'
resource.setrlimit(resource.RLIMIT_NOFILE, (max(soft, 4097), hard))
os.dup2(int(socket_fd), 100)
os.dup2(int(socket_fd), 4096)
os.dup2(int(policy_fd), 3)
if mode == 'compound-entry':
    os.dup2(os.open(os.path.dirname(policy), os.O_RDONLY | os.O_DIRECTORY), 0)
    os.dup2(100, 2)
    os.execv('/bin/bash', ['/bin/bash', os.path.join(os.path.dirname(helper), 'stability-linux-sandbox.sh'), 'setup'])
elif mode.startswith('socket-'):
    os.dup2(100, {'socket-stdin': 0, 'socket-stdout': 1, 'socket-stderr': 2}[mode])
elif mode == 'directory-stdin':
    os.dup2(os.open(os.path.dirname(policy), os.O_RDONLY | os.O_DIRECTORY), 0)
elif mode == 'memfd-stdin':
    os.dup2(os.memfd_create('owned-descriptor-negative'), 0)
elif mode == 'event-stdin':
    os.dup2(os.eventfd(0), 0)
elif mode == 'device-stdin':
    os.dup2(os.open('/dev/zero', os.O_RDONLY), 0)
elif mode == 'null-stdin':
    os.dup2(os.open('/dev/null', os.O_RDONLY), 0)
elif mode == 'file-stdin':
    os.dup2(os.open(policy, os.O_RDONLY), 0)
elif mode == 'closed-stdin':
    os.close(0)
resource.setrlimit(resource.RLIMIT_NOFILE, (1024, resource.getrlimit(resource.RLIMIT_NOFILE)[1]))
os.execv(sys.executable, [sys.executable, '-I', '-S', helper, policy,
    sys.executable, '-I', '-S', '-c', probe])
"""

PROBE = r"""
import errno, json, os
closed = []
for fd in (100, 4096):
    try:
        os.fstat(fd)
    except OSError as error:
        assert error.errno == errno.EBADF
        closed.append(fd)
try:
    os.fstat(0)
    stdin = os.read(0, 64).decode()
except OSError as error:
    assert error.errno == errno.EBADF
    stdin = 'closed'
print(json.dumps({'closed': closed, 'stdin': stdin, 'policy_open': os.fstat(3).st_size > 0}))
"""


@unittest.skipUnless(sys.platform == "linux" and os.geteuid() == 0, "requires owned Linux root fixture")
class DescriptorAdmission(unittest.TestCase):
    def exercise(self, mode="pipes", mismatch=False, writable=False):
        helper = pathlib.Path(__file__).with_name("stability-sandbox-exec.py")
        with tempfile.TemporaryDirectory(prefix="eliza-descriptor-test-") as directory:
            policy = pathlib.Path(directory) / "policy"
            policy.write_bytes(b"owned-policy-fixture")
            policy.chmod(0o400)
            other = pathlib.Path(directory) / "other"
            other.write_bytes(b"different-owned-policy")
            other.chmod(0o400)
            descriptor = os.open(other if mismatch else policy, os.O_RDWR if writable else os.O_RDONLY)
            left, right = socket.socketpair()
            try:
                result = subprocess.run(
                    [sys.executable, "-I", "-S", "-c", DRIVER, str(helper), str(policy),
                     str(descriptor), str(left.fileno()), mode, PROBE],
                    input="owned-pipe-input", capture_output=True, text=True,
                    pass_fds=(descriptor, left.fileno()), timeout=10,
                )
                right.setblocking(False)
                try:
                    received = right.recv(1024)
                except BlockingIOError:
                    # error-policy:J3 No queued bytes is the required negative result.
                    received = b""
                self.assertEqual(received, b"", "admission wrote through an inherited socket")
                return result
            finally:
                left.close()
                right.close()
                os.close(descriptor)

    def test_low_and_above_limit_sockets_are_closed_before_consumer(self):
        result = self.exercise()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "closed": [100, 4096], "stdin": "owned-pipe-input", "policy_open": True,
        })

    def test_closed_stdin_stays_closed(self):
        result = self.exercise("closed-stdin")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["stdin"], "closed")

    def test_socket_stdio_never_dispatches_consumer(self):
        for mode in ("socket-stdin", "socket-stdout", "socket-stderr"):
            with self.subTest(mode=mode):
                result = self.exercise(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                if mode == "socket-stderr":
                    self.assertEqual(result.stderr, "")
                else:
                    self.assertIn("socket-backed stdio", result.stderr)

    def test_entry_guard_precedes_interpreter_diagnostics(self):
        result = self.exercise("compound-entry")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_unsupported_stdio_never_dispatches_consumer(self):
        for mode in ("directory-stdin", "event-stdin", "memfd-stdin", "device-stdin"):
            with self.subTest(mode=mode):
                result = self.exercise(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                # CPython rejects directory stdin before executing the isolated helper.
                expected = "<stdin> is a directory" if mode == "directory-stdin" else "unsupported stdio descriptor kind"
                self.assertIn(expected, result.stderr)

    def test_actual_null_and_regular_stdio_are_admitted(self):
        for mode, expected in (("null-stdin", ""), ("file-stdin", "owned-policy-fixture")):
            with self.subTest(mode=mode):
                result = self.exercise(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["stdin"], expected)

    def test_different_policy_handle_never_dispatches_consumer(self):
        result = self.exercise(mismatch=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("exact read-only policy", result.stderr)

    def test_writable_policy_handle_never_dispatches_consumer(self):
        result = self.exercise(writable=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("exact read-only policy", result.stderr)


if __name__ == "__main__":
    unittest.main()
