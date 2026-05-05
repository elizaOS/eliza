#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rlvr-health")

DEFAULT_MIN_EVAL_SCORE = 60.0
DEFAULT_MAX_LOSS = 5.0
DEFAULT_ALERT_WEBHOOK_ENV = "RLVR_HEALTH_ALERT_WEBHOOK_URL"
SCORE_MISMATCH_TOLERANCE = 1e-6


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}")
    return payload


def tail_jsonl_object(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return None
    payload = json.loads(lines[-1])
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object row in {path}")
    return payload


def build_alert(level: str, code: str, message: str, *, path: str | None = None) -> dict[str, Any]:
    alert = {"level": level, "code": code, "message": message}
    if path:
        alert["path"] = path
    return alert


def load_artifact_score(path: Path) -> float:
    payload = load_json(path)
    score = payload.get("overallScore")
    if not isinstance(score, (int, float)):
        raise ValueError(f"Score artifact missing numeric overallScore at {path}")
    return float(score)


def validate_phase_artifacts(
    phase_name: str,
    phase_payload: dict[str, Any],
    *,
    alerts: list[dict[str, Any]],
    max_loss: float,
    min_eval_score: float,
) -> None:
    status = str(phase_payload.get("status", "unknown"))
    if status in {"failed", "error"}:
        alerts.append(
            build_alert(
                "critical",
                f"{phase_name}-failed",
                f"{phase_name} finished with status={status}",
            )
        )
        return

    if phase_name in {"sft", "distill"} and status == "completed":
        adapter_path = phase_payload.get("adapter_path")
        if not isinstance(adapter_path, str) or not Path(adapter_path).exists():
            alerts.append(
                build_alert(
                    "critical",
                    f"{phase_name}-missing-adapter",
                    f"{phase_name} completed but adapter artifact is missing.",
                    path=str(adapter_path),
                )
            )

    if phase_name == "grpo" and status == "completed":
        metrics_path = phase_payload.get("metrics_path")
        if isinstance(metrics_path, str) and metrics_path:
            metrics_file = Path(metrics_path)
            if not metrics_file.exists():
                alerts.append(
                    build_alert(
                        "critical",
                        "grpo-missing-metrics",
                        "GRPO completed but metrics file is missing.",
                        path=metrics_path,
                    )
                )
            else:
                final_metrics = tail_jsonl_object(metrics_file)
                if final_metrics is None:
                    alerts.append(
                        build_alert(
                            "critical",
                            "grpo-empty-metrics",
                            "GRPO metrics file is empty.",
                            path=metrics_path,
                        )
                    )
                else:
                    final_loss = final_metrics.get("loss")
                    if isinstance(final_loss, (int, float)) and final_loss > max_loss:
                        alerts.append(
                            build_alert(
                                "warning",
                                "grpo-loss-high",
                                f"GRPO final loss {final_loss:.4f} exceeds threshold {max_loss:.4f}.",
                                path=metrics_path,
                            )
                        )

        scenario_manifest = phase_payload.get("scenario_manifest")
        if not isinstance(scenario_manifest, str) or not Path(scenario_manifest).exists():
            alerts.append(
                build_alert(
                    "critical",
                    "grpo-missing-scenario-manifest",
                    "GRPO scenario manifest is missing.",
                    path=str(scenario_manifest),
                )
            )

        best_cots_path = phase_payload.get("best_cots_path")
        if not isinstance(best_cots_path, str) or not Path(best_cots_path).exists():
            alerts.append(
                build_alert(
                    "critical",
                    "grpo-missing-best-cots",
                    "GRPO best_cots artifact is missing.",
                    path=str(best_cots_path),
                )
            )
        elif int(phase_payload.get("best_cots_count") or 0) <= 0:
            alerts.append(
                build_alert(
                    "warning",
                    "grpo-zero-best-cots",
                    "GRPO finished without collecting any best CoTs.",
                    path=best_cots_path,
                )
            )

    if phase_name.startswith("eval_") and status == "completed":
        score_path = phase_payload.get("score_path")
        if not isinstance(score_path, str) or not Path(score_path).exists():
            alerts.append(
                build_alert(
                    "critical",
                    f"{phase_name}-missing-score",
                    f"{phase_name} completed but score artifact is missing.",
                    path=str(score_path),
                )
            )
            return
        try:
            artifact_score = load_artifact_score(Path(score_path))
        except ValueError as exc:
            alerts.append(
                build_alert(
                    "critical",
                    f"{phase_name}-invalid-score-artifact",
                    str(exc),
                    path=score_path,
                )
            )
            return
        reported_score = phase_payload.get("overall_score")
        if not isinstance(reported_score, (int, float)):
            alerts.append(
                build_alert(
                    "critical",
                    f"{phase_name}-invalid-score",
                    f"{phase_name} score is missing or invalid.",
                    path=score_path,
                )
            )
            return
        if abs(float(reported_score) - artifact_score) > SCORE_MISMATCH_TOLERANCE:
            alerts.append(
                build_alert(
                    "critical",
                    f"{phase_name}-score-mismatch",
                    f"{phase_name} report score {float(reported_score):.4f} does not match artifact score {artifact_score:.4f}.",
                    path=score_path,
                )
            )
            return
        if artifact_score < min_eval_score:
            alerts.append(
                build_alert(
                    "warning",
                    f"{phase_name}-score-low",
                    f"{phase_name} overall score {artifact_score:.4f} is below threshold {min_eval_score:.4f}.",
                    path=score_path,
                )
            )


def build_health_report(
    report: dict[str, Any],
    *,
    report_path: Path,
    min_eval_score: float,
    max_loss: float,
) -> dict[str, Any]:
    phases = report.get("phases")
    if not isinstance(phases, dict):
        raise ValueError("Pipeline report missing phases object.")

    alerts: list[dict[str, Any]] = []
    for phase_name, phase_payload in phases.items():
        if isinstance(phase_payload, dict):
            validate_phase_artifacts(
                phase_name,
                phase_payload,
                alerts=alerts,
                max_loss=max_loss,
                min_eval_score=min_eval_score,
            )

    if phases.get("distill", {}).get("status") == "completed" and "eval_distill" not in phases:
        alerts.append(
            build_alert(
                "warning",
                "distill-eval-missing",
                "Distillation completed without a recorded eval_distill phase.",
            )
        )

    if phases.get("sft", {}).get("status") == "completed" and "eval_sft" not in phases:
        alerts.append(
            build_alert(
                "warning",
                "sft-eval-missing",
                "SFT completed without a recorded eval_sft phase.",
            )
        )

    health_status = "healthy"
    if any(alert["level"] == "critical" for alert in alerts):
        health_status = "critical"
    elif alerts:
        health_status = "warning"

    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "report_path": str(report_path),
        "status": health_status,
        "alert_count": len(alerts),
        "alerts": alerts,
    }


def send_alert_webhook(
    *,
    webhook_url: str,
    health_report: dict[str, Any],
) -> dict[str, Any]:
    request = urllib.request.Request(
        webhook_url,
        data=json.dumps(health_report).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response_body = response.read().decode("utf-8").strip()
        return {
            "status_code": response.getcode(),
            "response_body": response_body,
        }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate RLVR pipeline artifacts and emit alerts."
    )
    parser.add_argument("--report", required=True, help="Path to rlvr_pipeline_report.json")
    parser.add_argument("--output", default="", help="Optional path for the health report JSON")
    parser.add_argument("--min-eval-score", type=float, default=DEFAULT_MIN_EVAL_SCORE)
    parser.add_argument("--max-loss", type=float, default=DEFAULT_MAX_LOSS)
    parser.add_argument(
        "--alert-webhook-url",
        default="",
        help=f"Optional webhook URL for warning/critical health reports. Defaults to ${DEFAULT_ALERT_WEBHOOK_ENV}.",
    )
    args = parser.parse_args()

    report_path = Path(args.report).resolve()
    output_path = (
        Path(args.output).resolve()
        if args.output
        else report_path.with_name("rlvr_pipeline_health.json")
    )

    try:
        report = load_json(report_path)
        health_report = build_health_report(
            report,
            report_path=report_path,
            min_eval_score=args.min_eval_score,
            max_loss=args.max_loss,
        )
    except Exception as exc:
        logger.error("Health validation failed for %s: %s", report_path, exc)
        health_report = {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "report_path": str(report_path),
            "status": "critical",
            "alert_count": 1,
            "alerts": [
                {
                    "level": "critical",
                    "code": "health-check-failed",
                    "message": str(exc),
                    "path": str(report_path),
                }
            ],
        }

    webhook_url = args.alert_webhook_url or os.environ.get(DEFAULT_ALERT_WEBHOOK_ENV, "")
    if webhook_url and health_report["status"] in {"warning", "critical"}:
        try:
            delivery = send_alert_webhook(
                webhook_url=webhook_url,
                health_report=health_report,
            )
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            logger.error("Alert delivery failed for %s: %s", webhook_url, exc)
            health_report["alertDelivery"] = {
                "status": "failed",
                "webhook_url": webhook_url,
                "error": str(exc),
            }
        else:
            health_report["alertDelivery"] = {
                "status": "delivered",
                "webhook_url": webhook_url,
                **delivery,
            }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(health_report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(health_report, indent=2))
    if health_report.get("alertDelivery", {}).get("status") == "failed":
        return 1
    return 1 if health_report["status"] == "critical" else 0


if __name__ == "__main__":
    raise SystemExit(main())
