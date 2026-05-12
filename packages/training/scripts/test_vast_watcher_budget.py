"""Integration test for the budget enforcement path through the watcher.

Verifies the bash watcher's contract by:
  1. Constructing an isolated ELIZA_STATE_DIR.
  2. Pointing the watcher at a stub `train_vast.sh` (which always succeeds)
     and pre-seeding ``.vast_instance_id`` so the watcher reads it.
  3. Replacing the python ``scripts.lib.vast_budget enforce`` invocation
     with one that returns the hard-cap exit code (11).
  4. Running the watcher with ``ELIZA_VAST_BUDGET_DRY_RUN=1`` and a tiny
     ``ELIZA_VAST_WATCH_INTERVAL_S=1`` so a single poll happens then
     the watcher exits cleanly via the hard-cap branch.
  5. Asserting an incident log with kind="hard_cap_breach" was written.

The test isolates everything to a tmpdir — no real vastai binary or
network is touched.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """Lay out a minimal ROOT with .vast_instance_id + stub train_vast.sh.

    The watcher reads ``$ROOT/scripts/train_vast.sh`` and
    ``$ROOT/.vast_instance_id``. We point it at a self-contained fake.
    """
    root = tmp_path / "repo"
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    (root / ".vast_instance_id").write_text("99999\n")

    # Stub train_vast.sh:
    #   - status   => succeeds (so watcher reaches the budget pass)
    #   - teardown => writes a sentinel file the test can assert
    fake_train_vast = scripts / "train_vast.sh"
    fake_train_vast.write_text(
        "#!/usr/bin/env bash\n"
        "case \"$1\" in\n"
        "  status)\n"
        "    echo '[fake-train] status: instance=99999 gpu=B200x2 runtime=2h $/hr=$3.51'\n"
        "    exit 0\n"
        "    ;;\n"
        "  teardown)\n"
        "    echo '[fake-train] destroying' > \"$ROOT_TEARDOWN_MARKER\"\n"
        "    exit 0\n"
        "    ;;\n"
        "  *)\n"
        "    echo \"[fake-train] unknown: $*\"\n"
        "    exit 2\n"
        "    ;;\n"
        "esac\n"
    )
    fake_train_vast.chmod(0o755)

    # Stub python module: shim that always reports the hard-cap exit
    # code via the same -m scripts.lib.vast_budget path the watcher uses.
    # We accomplish this by interposing a python wrapper that the
    # watcher will pick up first on PATH.
    return root


def _make_python_shim(tmp_path: Path, exit_code: int) -> Path:
    """A python3 shim that prints a one-line summary and exits with
    ``exit_code``. Placed first on PATH so the watcher's invocation of
    ``python3 -m scripts.lib.vast_budget enforce ...`` hits our shim.
    """
    bindir = tmp_path / "bin"
    bindir.mkdir()
    real_python = shutil.which("python3") or "/usr/bin/python3"
    shim = bindir / "python3"
    # The watcher calls: `python3 -m scripts.lib.vast_budget enforce <id>`.
    # The shim detects the vast_budget enforce path, prints a fake
    # summary line, exits with the desired code. Anything else falls
    # through to the real python so unrelated callers (e.g. shellcheck
    # subshell setup) keep working.
    shim.write_text(
        f"""#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    scripts.lib.vast_budget)
      echo "pipeline=test gpu=B200x2 runtime=6:00:00 \\$/hr=\\$3.00 total=\\$18.00 STATE=OVER_HARD_CAP"
      exit {exit_code}
      ;;
  esac
done
exec {real_python} "$@"
"""
    )
    shim.chmod(0o755)
    return bindir


def test_watcher_writes_hard_cap_incident_and_exits(
    fake_repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Hard-cap exit from enforce => watcher writes incident + exits cleanly.

    This is the M9 "dry-run with mocked rate, assert hard-cap teardown"
    test from the deliverables list.
    """
    state_dir = tmp_path / "eliza-state"
    state_dir.mkdir()
    teardown_marker = tmp_path / "teardown.marker"

    bindir = _make_python_shim(tmp_path, exit_code=11)

    # Find the real watcher script in the repo we're testing.
    real_repo = Path(__file__).resolve().parents[1]
    watcher = real_repo / "scripts" / "vast-watcher.sh"
    assert watcher.is_file()
    # Stage the watcher into the fake repo so its $ROOT resolves to
    # fake_repo, not the real one.
    staged = fake_repo / "scripts" / "vast-watcher.sh"
    staged.write_text(watcher.read_text())
    staged.chmod(0o755)

    env = os.environ.copy()
    env["ELIZA_STATE_DIR"] = str(state_dir)
    env["ELIZA_VAST_MAX_USD"] = "10"
    env["ELIZA_VAST_WATCH_INTERVAL_S"] = "1"
    env["ELIZA_VAST_BUDGET_DRY_RUN"] = "1"
    env["ROOT_TEARDOWN_MARKER"] = str(teardown_marker)
    env["PATH"] = f"{bindir}:{env.get('PATH', '')}"

    proc = subprocess.run(
        ["bash", str(staged)],
        env=env,
        cwd=str(fake_repo),
        capture_output=True,
        text=True,
        timeout=30,
    )

    # Hard-cap path => watcher exits 0 after writing the incident.
    assert proc.returncode == 0, (
        f"watcher exited with rc={proc.returncode}\n"
        f"stdout={proc.stdout}\nstderr={proc.stderr}"
    )

    incidents = list((state_dir / "vast-incidents").glob("*.log"))
    assert incidents, f"no incident logs written; stderr={proc.stderr}"
    body = incidents[-1].read_text()
    assert "hard_cap_breach" in body
    assert "STATE=OVER_HARD_CAP" in body

    # DRY_RUN=1 => the watcher must NOT call the real teardown
    # subcommand. Asserting the marker is absent proves that contract.
    assert not teardown_marker.exists(), (
        "watcher invoked teardown in DRY_RUN mode — that breaks the test "
        "harness contract and would have nuked a real instance"
    )


def test_watcher_does_not_enforce_when_no_cap_configured(
    fake_repo: Path, tmp_path: Path
) -> None:
    """Unset ELIZA_VAST_MAX_USD => watcher logs but never enforces.

    Verifies the opt-in contract: budget enforcement requires explicit
    activation. A watcher running without the env var must still work
    for liveness alerts but skip the budget pass entirely.
    """
    state_dir = tmp_path / "eliza-state"
    state_dir.mkdir()
    teardown_marker = tmp_path / "teardown.marker"

    # Shim returns hard-cap (11) IF asked, but we never expect it to be asked.
    bindir = _make_python_shim(tmp_path, exit_code=11)

    real_repo = Path(__file__).resolve().parents[1]
    watcher = real_repo / "scripts" / "vast-watcher.sh"
    staged = fake_repo / "scripts" / "vast-watcher.sh"
    staged.write_text(watcher.read_text())
    staged.chmod(0o755)

    env = os.environ.copy()
    env["ELIZA_STATE_DIR"] = str(state_dir)
    env.pop("ELIZA_VAST_MAX_USD", None)
    env["ELIZA_VAST_WATCH_INTERVAL_S"] = "1"
    env["ELIZA_VAST_BUDGET_DRY_RUN"] = "1"
    env["ROOT_TEARDOWN_MARKER"] = str(teardown_marker)
    env["PATH"] = f"{bindir}:{env.get('PATH', '')}"

    proc = subprocess.Popen(
        ["bash", str(staged)],
        env=env,
        cwd=str(fake_repo),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    # Let it run for a couple of polls then kill — there's no exit
    # condition when budget enforcement is off and the instance keeps
    # reporting healthy.
    time.sleep(3)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    stdout = proc.stdout.read() if proc.stdout else ""

    assert "budget enforcement: disabled" in stdout
    assert not teardown_marker.exists()
    # No hard-cap incident should have fired.
    incidents_dir = state_dir / "vast-incidents"
    if incidents_dir.exists():
        for inc in incidents_dir.glob("*.log"):
            assert "hard_cap_breach" not in inc.read_text()
