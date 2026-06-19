#!/usr/bin/env python3
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def write_fake_docker(bin_dir: Path, log_path: Path) -> None:
    docker = bin_dir / "docker"
    docker.write_text(
        f"""#!/usr/bin/env sh
set -eu
log={str(log_path)!r}
printf '%s\\n' "$*" >> "$log"
case "$1 $2" in
  "image inspect")
    exit 0
    ;;
  "ps --filter")
    if [ "${{FAKE_DOCKER_PS:-}}" = "active" ]; then
      printf 'fake-container Up 10 minutes openlane-test\\n'
    fi
    exit 0
    ;;
  "run --rm")
    cidfile=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--cidfile" ]; then
        cidfile="$2"
        shift 2
        continue
      fi
      shift
    done
    if [ -n "$cidfile" ]; then
      printf 'fake-container-id\\n' > "$cidfile"
    fi
    exit 0
    ;;
  "rm -f")
    exit 0
    ;;
esac
exit 0
"""
    )
    docker.chmod(0o755)


def run_launcher(env: dict[str, str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(ROOT / "scripts/run_openlane.sh")],
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def base_env(tmp: Path, log_path: Path) -> dict[str, str]:
    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    write_fake_docker(bin_dir, log_path)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:/usr/bin:/bin"
    env["OPENLANE_LOCK_DIR"] = str(tmp / "openlane.lock")
    env["OPENLANE_IMAGE"] = "fake/openlane:test"
    env["PDK_ROOT"] = str(ROOT / "external/pdks")
    env.pop("OPENLANE_TIMEOUT_SECONDS", None)
    return env


def test_docker_run_uses_repo_mount_labels_and_cleans_lock() -> None:
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        log_path = tmp / "docker.log"
        env = base_env(tmp, log_path)
        outside_cwd = tmp / "outside"
        outside_cwd.mkdir()

        result = run_launcher(env, outside_cwd)

        assert result.returncode == 0, result.stdout + result.stderr
        log = log_path.read_text()
        assert f"--label eliza.repo={ROOT}" in log, log
        assert "--label eliza.openlane=1" in log, log
        assert f"-v {ROOT}:/work" in log, log
        assert "-w /work" in log, log
        assert not Path(env["OPENLANE_LOCK_DIR"]).exists()


def test_stale_lock_is_preserved_when_labeled_container_is_active() -> None:
    with tempfile.TemporaryDirectory() as tmp_name:
        tmp = Path(tmp_name)
        log_path = tmp / "docker.log"
        env = base_env(tmp, log_path)
        env["FAKE_DOCKER_PS"] = "active"
        lock_dir = Path(env["OPENLANE_LOCK_DIR"])
        lock_dir.mkdir()
        (lock_dir / "pid").write_text("999999\n")

        result = run_launcher(env, tmp)

        assert result.returncode == 3, result.stdout + result.stderr
        assert "OpenLane Docker container already active" in result.stdout
        assert lock_dir.exists()


def test_timeout_wrapper_reports_exit_124() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/run_with_timeout.py"),
            "--timeout-seconds",
            "1",
            "--label",
            "unit",
            "--",
            sys.executable,
            "-c",
            "import time; time.sleep(5)",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 124, result.stdout + result.stderr
    assert "status=timeout" in result.stderr


def main() -> int:
    test_docker_run_uses_repo_mount_labels_and_cleans_lock()
    test_stale_lock_is_preserved_when_labeled_container_is_active()
    test_timeout_wrapper_reports_exit_124()
    print("OpenLane orchestration tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
