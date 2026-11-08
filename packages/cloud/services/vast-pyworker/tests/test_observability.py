import http.server
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]


def wait_for(predicate, message, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(message)


def process_exited(pid):
    # Orphans can briefly remain zombies under a container init. They have no
    # open descriptors or execution and cannot retain the observer lock.
    stat = Path(f"/proc/{pid}/stat")
    if sys.platform == "linux" and stat.exists():
        try:
            if stat.read_text().split(")", 1)[1].split()[0] == "Z":
                return True
        except FileNotFoundError:
            return True
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True


class MetricsHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"vllm:num_requests_running 2\n")

    def log_message(self, *_args):
        pass


class ObservabilityTests(unittest.TestCase):
    def test_existing_heartbeat_cli_finishes_requested_iterations(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MetricsHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "heartbeat.jsonl"
                result = subprocess.run(
                    [
                        sys.executable,
                        str(
                            SERVICE.parents[2]
                            / "training/scripts/inference/heartbeat.py"
                        ),
                        "--vllm-metrics-url",
                        f"http://127.0.0.1:{server.server_port}/metrics",
                        "--out",
                        str(output),
                        "--interval-seconds",
                        ".01",
                        "--label",
                        "cli-compatible",
                        "--max-iterations",
                        "2",
                    ],
                    capture_output=True,
                    check=False,
                    text=True,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                rows = [json.loads(line) for line in output.read_text().splitlines()]
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["num_requests_running"], 2)
                self.assertEqual(rows[0]["label"], "cli-compatible")
        finally:
            server.shutdown()
            server.server_close()

    def test_full_bootstrap_reuses_observers_preserves_history_and_stops_all_writers(
        self,
    ):
        # Exercise the complete shell bootstrap and real Python supervisor.
        # Git/install/model probes and worker handoff are fixtures: no model,
        # SDK HTTP server, GPU, or external provider service is started.
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MetricsHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        supervisors = []
        live_owner = None
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bin_dir = root / "bin"
                bin_dir.mkdir()
                repo = root / "repo"
                service = repo / "packages/cloud/services/vast-pyworker"
                service.mkdir(parents=True)
                (repo / ".git").mkdir()
                (service / "observability.py").write_bytes(
                    (SERVICE / "observability.py").read_bytes()
                )
                heartbeat = repo / "packages/training/scripts/inference/heartbeat.py"
                heartbeat.parent.mkdir(parents=True)
                (heartbeat.parent / "__init__.py").touch()
                (heartbeat.parent.parent / "__init__.py").touch()
                heartbeat.write_bytes(
                    (
                        SERVICE.parents[2] / "training/scripts/inference/heartbeat.py"
                    ).read_bytes()
                )
                # An older externally installed heartbeat has no stop_event
                # API. Bootstrap must load the module from its own checkout.
                stale_heartbeat = root / "scripts/inference/heartbeat.py"
                stale_heartbeat.parent.mkdir(parents=True)
                (stale_heartbeat.parent / "__init__.py").touch()
                (stale_heartbeat.parent.parent / "__init__.py").touch()
                stale_heartbeat.write_text(
                    "def main():\n    raise RuntimeError('stale heartbeat selected')\n"
                )
                for name in ("git", "pip", "pgrep"):
                    path = bin_dir / name
                    path.write_text("#!/bin/sh\nexit 0\n")
                    path.chmod(0o755)
                python = bin_dir / "python3"
                python.write_text(
                    f'#!/bin/sh\nif [ "$1" = "worker.py" ]; then exit 0; fi\nexec "{sys.executable}" "$@"\n'
                )
                python.chmod(0o755)
                stats = root / "stats.jsonl"
                stats.write_text('{"earlier_observation":true}\n')
                heartbeat_out = root / "heartbeat-pids"
                supervisor_log = root / "supervisor.log"
                env = os.environ.copy()
                env.update(
                    {
                        "PATH": f"{bin_dir}:/opt/homebrew/bin:/usr/bin:/bin",
                        "PYTHONPATH": str(root),
                        "ELIZA_VAST_MANIFEST": "/nonexistent-fixture-manifest.json",
                        "MODEL_REPO": "fixture/model",
                        "MODEL_ALIAS": "fixture-model",
                        "PYWORKER_DIR": str(repo),
                        "HF_HOME": str(root / "hf"),
                        "VLLM_LOG": str(root / "model.log"),
                        "VLLM_METRICS_PORT": str(server.server_port),
                        "VLLM_STATS_PATH": str(stats),
                        "VLLM_STATS_INTERVAL_S": ".05",
                        "HEARTBEAT_OUT": str(heartbeat_out),
                        "HEARTBEAT_INTERVAL_SECONDS": ".05",
                        "HEARTBEAT_LOG": str(root / "heartbeat.log"),
                        "VLLM_OBSERVABILITY_LOG": str(supervisor_log),
                    }
                )
                for attempt in range(3):
                    result = subprocess.run(
                        ["bash", str(SERVICE / "onstart-vllm.sh")],
                        env=env,
                        text=True,
                        capture_output=True,
                        check=False,
                        timeout=10,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    pid_line = next(
                        line
                        for line in result.stdout.splitlines()
                        if "observability supervisor pid:" in line
                    )
                    supervisors.append(int(pid_line.rsplit(" ", 1)[-1]))
                    if attempt == 0:
                        live_owner = supervisors[0]
                        wait_for(
                            lambda: (
                                heartbeat_out.exists()
                                and heartbeat_out.read_text().strip()
                            ),
                            "heartbeat not started",
                        )
                    else:
                        wait_for(
                            lambda attempt=attempt: (
                                supervisor_log.read_text().count("reusing the active")
                                >= attempt
                            ),
                            "duplicate owner did not exit",
                        )
                wait_for(
                    lambda: "requests_running" in stats.read_text(),
                    "no metrics observation written",
                )
                self.assertEqual(
                    stats.read_text().splitlines()[0], '{"earlier_observation":true}'
                )
                for line in stats.read_text().splitlines():
                    json.loads(line)
                # SIGKILL must stop both writers: heartbeat is a thread in
                # the same process, rather than an orphanable subprocess.
                os.kill(live_owner, signal.SIGKILL)
                wait_for(
                    lambda: process_exited(live_owner), "observer survived SIGKILL"
                )
                retained = heartbeat_out.read_bytes()
                time.sleep(0.2)
                self.assertEqual(heartbeat_out.read_bytes(), retained)
                result = subprocess.run(
                    ["bash", str(SERVICE / "onstart-vllm.sh")],
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                    timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                pid_line = next(
                    line
                    for line in result.stdout.splitlines()
                    if "observability supervisor pid:" in line
                )
                live_owner = int(pid_line.rsplit(" ", 1)[-1])
                supervisors.append(live_owner)
                wait_for(
                    lambda: len(heartbeat_out.read_bytes()) > len(retained),
                    "replacement heartbeat did not append",
                )
                self.assertTrue(heartbeat_out.read_bytes().startswith(retained))
                os.kill(live_owner, signal.SIGTERM)
                wait_for(
                    lambda: process_exited(live_owner),
                    "observer did not join heartbeat on SIGTERM",
                )
                retained = heartbeat_out.read_bytes()
                time.sleep(0.2)
                self.assertEqual(heartbeat_out.read_bytes(), retained)
                self.assertEqual(
                    stats.read_text().splitlines()[0], '{"earlier_observation":true}'
                )
                for line in heartbeat_out.read_text().splitlines():
                    json.loads(line)
                live_owner = None
        finally:
            for pid in supervisors:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
