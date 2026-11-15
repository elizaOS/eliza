"""Real process-group cleanup, including Darwin's zombie-only EPERM."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

_MODULE_PATH = Path(__file__).resolve().parent.parent / "scripts" / "acceptance_gate.py"
_spec = importlib.util.spec_from_file_location("acceptance_group_under_test", _MODULE_PATH)
assert _spec is not None and _spec.loader is not None
gate = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = gate
_spec.loader.exec_module(gate)


def _stop_owned(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        # The unreaped Popen child still owns this PID; never signal a reused PID.
        assert os.getpgid(process.pid) == process.pid != os.getpgrp()
        process.kill()
    process.wait(timeout=5)
    if process.stdout:
        process.stdout.close()
    if process.stdin:
        process.stdin.close()


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin zombie-only EPERM")
def test_darwin_zombie_only_descendant_does_not_abort_cleanup(monkeypatch) -> None:
    child_script = (
        "import os, signal\n"
        "signal.signal(signal.SIGTERM, signal.SIG_DFL)\n"
        "print(os.getpid(), os.getpgrp(), os.getuid(), flush=True)\n"
        "while True: signal.pause()\n"
    )
    parent_script = (
        "import json, os, signal, subprocess, sys\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        f"child = subprocess.Popen([sys.executable, '-c', {child_script!r}], "
        "start_new_session=True, stdout=subprocess.PIPE, text=True)\n"
        "print(json.dumps([int(x) for x in child.stdout.readline().split()]), flush=True)\n"
        # Retain the child's zombie until this parent is killed.
        "while True: signal.pause()\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", parent_script],
        start_new_session=True, stdout=subprocess.PIPE, text=True,
    )
    unrelated = subprocess.Popen(
        [sys.executable, "-c", "import signal; signal.pause()"],
        start_new_session=True, text=True,
    )
    original_killpg = os.killpg
    denials: list[tuple[int, int]] = []
    child_pid = None

    def record_signal(group: int, signum: int) -> None:
        try:
            original_killpg(group, signum)
            if group == child_pid and signum == signal.SIGTERM:
                deadline = time.monotonic() + 30
                while True:
                    state = subprocess.check_output(
                        ["ps", "-p", str(child_pid), "-o", "stat="],
                        text=True, timeout=gate.PROCESS_INSPECTION_TIMEOUT_S,
                    ).strip()
                    if state.startswith("Z"):
                        break
                    assert time.monotonic() < deadline, "child did not become a zombie"
                    time.sleep(0.01)
        except PermissionError:
            denials.append((group, signum))
            raise

    try:
        assert parent.stdout is not None
        child_pid, child_group, child_uid = json.loads(parent.stdout.readline())
        assert child_pid == child_group
        assert child_uid == os.getuid()
        assert child_group not in {os.getpgrp(), unrelated.pid, parent.pid}
        monkeypatch.setattr(gate, "PROCESS_TERMINATION_GRACE_S", 0.1)
        monkeypatch.setattr(gate.os, "killpg", record_signal)
        gate._terminate_process_tree(parent)
        assert (child_group, signal.SIGKILL) in denials
        assert parent.returncode == -signal.SIGKILL
        assert unrelated.poll() is None
    finally:
        if parent.poll() is None and child_pid is not None:
            # This parent never reaps its child, so its child PID is still reserved.
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        _stop_owned(parent)
        _stop_owned(unrelated)


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group inspection")
@pytest.mark.parametrize("inspection", ["live", "failed", "timeout", "malformed", "empty"])
def test_denied_signal_requires_confirmed_absence_of_live_members(monkeypatch, inspection) -> None:
    process = subprocess.Popen(
        [sys.executable, "-c", "import os, signal; print(os.getpid(), flush=True); signal.pause()"],
        start_new_session=True, stdout=subprocess.PIPE, text=True,
    )
    denied = PermissionError(1, "controlled signal denial")

    def deny_signal(group: int, signum: int) -> None:
        assert group == process.pid != os.getpgrp()
        raise denied

    def inspect_failure(*args, **kwargs):
        assert kwargs["timeout"] == gate.PROCESS_INSPECTION_TIMEOUT_S
        raise subprocess.CalledProcessError(1, args[0])

    def inspect_timeout(*args, **kwargs):
        assert kwargs["timeout"] == gate.PROCESS_INSPECTION_TIMEOUT_S
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    def inspect_malformed(*args, **kwargs):
        return subprocess.CompletedProcess(args[0], 0, "malformed\n", "")

    def inspect_empty(*args, **kwargs):
        return subprocess.CompletedProcess(args[0], 0, "", "")

    try:
        assert process.stdout is not None
        assert int(process.stdout.readline()) == process.pid
        monkeypatch.setattr(gate.sys, "platform", "darwin")
        monkeypatch.setattr(gate.os, "killpg", deny_signal)
        if inspection != "live":
            monkeypatch.setattr(gate.subprocess, "run", {
                "failed": inspect_failure,
                "timeout": inspect_timeout,
                "malformed": inspect_malformed,
                "empty": inspect_empty,
            }[inspection])
        with pytest.raises(PermissionError) as raised:
            gate._signal_posix_process_group(process.pid, signal.SIGKILL)
        assert raised.value is denied
        if inspection != "live":
            assert raised.value.__cause__ is not None
        assert process.poll() is None
    finally:
        _stop_owned(process)
