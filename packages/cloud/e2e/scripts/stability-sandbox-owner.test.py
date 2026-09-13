"""Exercise real cleanup deadline admission, process timeout, and nested ownership.

Only duration/journal inputs are fixtures. Timers and owned child processes are
real; no account, filesystem ownership, firewall, or systemd mutations occur.
"""
import importlib.util
import contextlib
import pathlib
import signal
import subprocess
import sys
import time
import unittest

source = pathlib.Path(__file__).with_name("stability-sandbox-owner.py")
spec = importlib.util.spec_from_file_location("owner", source)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)

class Journal:
    def __init__(self, milliseconds):
        self.milliseconds = milliseconds
    def read(self):
        return [{"event": "owner-started", "data": {"attemptTimeoutMs": self.milliseconds}}]

class CleanupBudgetTests(unittest.TestCase):
    def test_rejects_unsupported_duration_before_process_identity_or_service(self):
        original = owner.process_identity
        def forbidden(*args):
            self.fail("unsupported duration reached process/service acquisition")
        owner.process_identity = forbidden
        try:
            for value in [True, 0, -1, 600001, 1.5, "180000", None]:
                with self.subTest(value=value), self.assertRaises(RuntimeError):
                    owner.controller("unused", [], {}, auth_request={"context": {"timeoutMs": value}})
        finally:
            owner.process_identity = original

    def test_nested_steps_do_not_refresh_aggregate_deadline(self):
        with self.assertRaisesRegex(TimeoutError, "aggregate sandbox operation deadline"):
            with owner.cleanup_budget(Journal(80)):
                first = owner._cleanup_deadline
                time.sleep(.045)
                with owner.cleanup_budget(Journal(240000)):
                    self.assertEqual(owner._cleanup_deadline, first)
                    time.sleep(.06)
        self.assertIsNone(owner._cleanup_deadline)

    def test_timer_setup_failure_restores_handler_and_global_state(self):
        previous = signal.getsignal(signal.SIGALRM)
        original = signal.setitimer
        def fail_arm(which, seconds, *args):
            if seconds:
                raise OSError("owned timer setup failure")
            return original(which, seconds, *args)
        signal.setitimer = fail_arm
        try:
            with self.assertRaisesRegex(OSError, "owned timer setup failure"):
                with owner.cleanup_budget(Journal(1)):
                    self.fail("timer setup failure admitted cleanup")
            self.assertIsNone(owner._cleanup_deadline)
            self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        finally:
            signal.setitimer = original

    def test_external_child_is_bounded_by_remaining_budget(self):
        started = time.monotonic()
        with self.assertRaises((TimeoutError, subprocess.TimeoutExpired)):
            with owner.cleanup_budget(Journal(100)):
                owner.command([sys.executable, "-I", "-S", "-c", "import time;time.sleep(3)"], timeout=5)
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNone(owner._cleanup_deadline)

    def test_successful_cleanup_releases_timer_for_next_operation(self):
        for _ in range(2):
            with owner.cleanup_budget(Journal(1000)):
                result = owner.command([sys.executable, "-I", "-S", "-c", "print('owned')"])
                self.assertEqual(result.stdout.strip(), b"owned")
            self.assertIsNone(owner._cleanup_deadline)

    def test_explicit_short_admission_expires_before_account_creation(self):
        class AdmissionJournal:
            nonce = "a" * 32
            def __init__(self):
                self.rows = []
            def read(self):
                return self.rows.copy()
            def append(self, event, data):
                self.rows.append({"event": event, "data": data})
        journal = AdmissionJournal()
        old_lock, old_inspect, old_command = owner.identity_admission_lock, owner.inspect_identity_resources, owner.command
        owner.identity_admission_lock = contextlib.nullcontext
        owner.inspect_identity_resources = lambda *args: time.sleep(.1)
        def forbidden(*args, **kwargs):
            self.fail("expired admission reached account creation")
        owner.command = forbidden
        try:
            with self.assertRaisesRegex(TimeoutError, "aggregate sandbox operation deadline"):
                owner.allocate_identity(journal, time.monotonic() + .04)
            self.assertEqual([row["event"] for row in journal.rows], ["identity-candidate"])
            self.assertIsNone(owner._cleanup_deadline)
        finally:
            owner.identity_admission_lock, owner.inspect_identity_resources, owner.command = old_lock, old_inspect, old_command

    def test_inherited_deadline_does_not_restart_scan_window(self):
        expired = time.monotonic() - 1
        with self.assertRaises(TimeoutError):
            owner.remaining_external_deadline(expired)
        with self.assertRaises(TimeoutError):
            owner.remaining_external_deadline(float("nan"))
        with self.assertRaises(TimeoutError):
            owner.remaining_external_deadline(time.monotonic() + 601)
        deadline = time.monotonic() + 1
        first = owner.remaining_external_deadline(deadline)
        time.sleep(.01)
        self.assertLess(owner.remaining_external_deadline(deadline), first)

if __name__ == "__main__":
    unittest.main()
