from __future__ import annotations

import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest


def _venv_python() -> Path:
    return Path(__file__).resolve().parents[1] / ".venv" / "bin" / "python"


def _script_path() -> Path:
    return Path(__file__).resolve().parents[1] / "scripts" / "test_pipeline.py"


def _write_local_export(export_dir: Path) -> None:
    payload = {
        "trajectoryId": "traj-local-1",
        "agentId": "agent-local-1",
        "windowId": "window-local",
        "stepsJson": '[{"stepNumber":1,"timestamp":1001,"environmentState":{"agentBalance":10000,"agentPnL":12.5,"openPositions":0,"activeMarkets":1},"llmCalls":[{"model":"tiny-test","systemPrompt":"ssssssssssssssssssssssssssssss","userPrompt":"uuuuuuuuuuuuuuuuuuuuuuuuuuuuuu","response":"rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr","temperature":0.2,"maxTokens":64,"purpose":"action"}],"action":{"actionType":"trade","parameters":{"marketId":"market-one"},"success":true},"reward":0.1}]',
        "finalPnL": 12.5,
        "episodeLength": 1,
        "finalStatus": "completed",
    }
    export_dir.mkdir(parents=True)
    (export_dir / "trajectories.jsonl").write_text(
        json.dumps(payload) + "\n",
        encoding="utf-8",
    )


def _write_throughput_report(path: Path, gpu: str) -> None:
    path.write_text(
        json.dumps(
            {
                "gpu": gpu,
                "model": "Qwen/Qwen3.5-9B",
                "max_seq_length": 131072,
                "effective_tokens_per_second": 1024.5,
                "batch_size": 1,
                "gradient_accumulation_steps": 8,
                "measured_at": "2026-03-29T00:00:00Z",
                "command": "python scripts/run_pipeline.py --mode train --prepare-only",
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_preflight_script_passes_with_real_local_checks(tmp_path: Path) -> None:
    venv_python = _venv_python()
    if not venv_python.exists():
        pytest.skip("training venv is not available for real smoke execution")

    export_dir = tmp_path / "export"
    _write_local_export(export_dir)
    h100_report = tmp_path / "h100-throughput.json"
    h200_report = tmp_path / "h200-throughput.json"
    _write_throughput_report(h100_report, "h100")
    _write_throughput_report(h200_report, "h200")

    deliveries: list[dict[str, object]] = []

    class AlertHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8")
            deliveries.append(json.loads(body))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, format: str, *args: object) -> None:
            return None

    server = HTTPServer(("127.0.0.1", 0), AlertHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = dict(os.environ)
        env.pop("TINKER_API_KEY", None)
        env["TM_API_KEY"] = "alias-key"
        env["DATABASE_URL"] = "postgresql://example.invalid/test"
        env["OPENAI_API_KEY"] = "sk-test"

        proc = subprocess.run(
            [
                str(venv_python),
                str(_script_path()),
                "--local-export-dir",
                str(export_dir),
                "--alert-webhook-url",
                f"http://127.0.0.1:{server.server_port}/alerts",
                "--ping-alert-webhook",
                "--throughput-report",
                str(h100_report),
                "--throughput-report",
                str(h200_report),
                "--require-throughput-gpus",
                "h100,h200",
                "--json",
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["summary"] == {"passed": 7, "failed": 0, "blocked": 0}
    assert any(
        item["name"] == "tinker_dry_run" and item["status"] == "passed"
        for item in payload["results"]
    )
    assert deliveries[0]["event"] == "training_preflight_ping"


def test_preflight_script_rejects_invalid_throughput_report(tmp_path: Path) -> None:
    venv_python = _venv_python()
    if not venv_python.exists():
        pytest.skip("training venv is not available for real smoke execution")

    bad_report = tmp_path / "bad-throughput.json"
    bad_report.write_text(json.dumps({"gpu": "h100"}) + "\n", encoding="utf-8")

    proc = subprocess.run(
        [
            str(venv_python),
            str(_script_path()),
            "--skip-local-smoke",
            "--skip-dependency-audit",
            "--skip-release-status",
            "--skip-nebius-dry-run",
            "--skip-tinker-dry-run",
            "--skip-alert-check",
            "--throughput-report",
            str(bad_report),
            "--require-throughput-gpus",
            "h100",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    result = payload["results"][0]
    assert result["name"] == "throughput_reports"
    assert result["status"] == "failed"
    assert "missing required field" in result["message"]
