from __future__ import annotations

import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "check_rlvr_pipeline_health.py"

if not SCRIPT_PATH.exists():
    pytest.skip(f"script not found: {SCRIPT_PATH.name}", allow_module_level=True)


def write_report(tmp_path: Path, phases: dict[str, object]) -> Path:
    report_path = tmp_path / "rlvr_pipeline_report.json"
    report_path.write_text(
        json.dumps({"pipeline": "rlvr", "phases": phases}, indent=2),
        encoding="utf-8",
    )
    return report_path


def run_health_check(report_path: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--report", str(report_path), *extra_args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_check_rlvr_pipeline_health_reports_healthy_run(tmp_path: Path) -> None:
    adapter = tmp_path / "adapters.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    score = tmp_path / "eval-score.json"
    score.write_text(json.dumps({"overallScore": 91.0}), encoding="utf-8")
    metrics = tmp_path / "training_metrics.jsonl"
    metrics.write_text(json.dumps({"loss": 0.32}) + "\n", encoding="utf-8")
    scenario_manifest = tmp_path / "scenario_manifest.json"
    scenario_manifest.write_text(json.dumps({"scenarioCount": 1}), encoding="utf-8")
    best_cots = tmp_path / "best_cots.jsonl"
    best_cots.write_text(json.dumps({"scenario_id": "scenario-1"}) + "\n", encoding="utf-8")
    report_path = write_report(
        tmp_path,
        {
            "sft": {"status": "completed", "adapter_path": str(adapter)},
            "eval_sft": {"status": "completed", "score_path": str(score), "overall_score": 91.0},
            "grpo": {
                "status": "completed",
                "metrics_path": str(metrics),
                "scenario_manifest": str(scenario_manifest),
                "best_cots_path": str(best_cots),
                "best_cots_count": 1,
            },
        },
    )
    proc = run_health_check(report_path)

    assert proc.returncode == 0
    health = json.loads(proc.stdout)
    assert health["status"] == "healthy"
    assert health["alert_count"] == 0


def test_check_rlvr_pipeline_health_reports_critical_missing_artifacts(tmp_path: Path) -> None:
    report_path = write_report(
        tmp_path,
        {
            "distill": {"status": "completed", "adapter_path": str(tmp_path / "missing")},
            "eval_distill": {
                "status": "completed",
                "score_path": str(tmp_path / "missing-score"),
                "overall_score": 10.0,
            },
        },
    )
    proc = run_health_check(report_path)

    assert proc.returncode == 1
    health = json.loads(proc.stdout)
    assert health["status"] == "critical"
    assert any(alert["code"] == "distill-missing-adapter" for alert in health["alerts"])


def test_check_rlvr_pipeline_health_warns_for_low_eval_score_on_real_scale(tmp_path: Path) -> None:
    adapter = tmp_path / "adapters.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    score = tmp_path / "eval-score.json"
    score.write_text(json.dumps({"overallScore": 55.0}), encoding="utf-8")
    report_path = write_report(
        tmp_path,
        {
            "sft": {"status": "completed", "adapter_path": str(adapter)},
            "eval_sft": {"status": "completed", "score_path": str(score), "overall_score": 55.0},
        },
    )
    proc = run_health_check(report_path)

    assert proc.returncode == 0
    health = json.loads(proc.stdout)
    assert health["status"] == "warning"
    assert any(alert["code"] == "eval_sft-score-low" for alert in health["alerts"])


def test_check_rlvr_pipeline_health_rejects_score_mismatch(tmp_path: Path) -> None:
    adapter = tmp_path / "adapters.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    score = tmp_path / "eval-score.json"
    score.write_text(json.dumps({"overallScore": 55.0}), encoding="utf-8")
    report_path = write_report(
        tmp_path,
        {
            "sft": {"status": "completed", "adapter_path": str(adapter)},
            "eval_sft": {"status": "completed", "score_path": str(score), "overall_score": 91.0},
        },
    )
    proc = run_health_check(report_path)

    assert proc.returncode == 1
    health = json.loads(proc.stdout)
    assert health["status"] == "critical"
    assert any(alert["code"] == "eval_sft-score-mismatch" for alert in health["alerts"])


def test_check_rlvr_pipeline_health_handles_invalid_report_shape(tmp_path: Path) -> None:
    report_path = tmp_path / "rlvr_pipeline_report.json"
    report_path.write_text(json.dumps({"pipeline": "rlvr", "phases": []}), encoding="utf-8")
    proc = run_health_check(report_path)

    assert proc.returncode == 1
    health = json.loads(proc.stdout)
    assert health["status"] == "critical"
    assert health["alerts"][0]["code"] == "health-check-failed"
    assert "missing phases object" in health["alerts"][0]["message"].lower()
    assert "Health validation failed" in proc.stderr


def test_check_rlvr_pipeline_health_delivers_webhook_for_warning(tmp_path: Path) -> None:
    adapter = tmp_path / "adapters.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    score = tmp_path / "eval-score.json"
    score.write_text(json.dumps({"overallScore": 55.0}), encoding="utf-8")
    report_path = write_report(
        tmp_path,
        {
            "sft": {"status": "completed", "adapter_path": str(adapter)},
            "eval_sft": {"status": "completed", "score_path": str(score), "overall_score": 55.0},
        },
    )

    received: list[dict[str, object]] = []

    class WebhookHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            content_length = int(self.headers["Content-Length"])
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            received.append(payload)
            self.send_response(204)
            self.end_headers()

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), WebhookHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    webhook_url = f"http://127.0.0.1:{server.server_address[1]}/health"

    try:
        proc = run_health_check(report_path, "--alert-webhook-url", webhook_url)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert proc.returncode == 0
    health = json.loads(proc.stdout)
    assert health["status"] == "warning"
    assert health["alertDelivery"]["status"] == "delivered"
    assert health["alertDelivery"]["status_code"] == 204
    assert len(received) == 1
    assert received[0]["status"] == "warning"
    assert received[0]["alert_count"] == 1
    assert received[0]["alerts"][0]["code"] == "eval_sft-score-low"


def test_check_rlvr_pipeline_health_fails_when_webhook_delivery_breaks(tmp_path: Path) -> None:
    adapter = tmp_path / "adapters.safetensors"
    adapter.write_text("adapter", encoding="utf-8")
    score = tmp_path / "eval-score.json"
    score.write_text(json.dumps({"overallScore": 55.0}), encoding="utf-8")
    report_path = write_report(
        tmp_path,
        {
            "sft": {"status": "completed", "adapter_path": str(adapter)},
            "eval_sft": {"status": "completed", "score_path": str(score), "overall_score": 55.0},
        },
    )
    proc = run_health_check(report_path, "--alert-webhook-url", "http://127.0.0.1:1/health")

    assert proc.returncode == 1
    health = json.loads(proc.stdout)
    assert health["status"] == "warning"
    assert health["alertDelivery"]["status"] == "failed"
    assert "Alert delivery failed" in proc.stderr
