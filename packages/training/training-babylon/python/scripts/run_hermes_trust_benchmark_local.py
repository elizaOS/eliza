#!/usr/bin/env python3
"""Run the trust benchmark through the Hermes agent runtime."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def resolve_trust_bench_root(workspace_root: Path) -> Path:
    candidates = [
        workspace_root / "benchmarks" / "trust",
        workspace_root / "external-sources" / "benchmarks" / "trust",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


TRUST_BENCH_ROOT = resolve_trust_bench_root(Path(__file__).resolve().parents[5])
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))
sys.path.insert(0, str(TRUST_BENCH_ROOT))

import run_trust_benchmark_local as trust_local
from hermes_bridge import HermesBridgeClient


class HermesTrustBenchmarkHandler:
    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        name: str,
        max_iterations: int,
        hermes_root: str | None,
    ) -> None:
        self._name = name
        self._artifact_dir: Path | None = None
        self._client = HermesBridgeClient(
            model=model,
            base_url=base_url,
            api_key=api_key,
            max_iterations=max_iterations,
            hermes_root=hermes_root,
        )

    @property
    def name(self) -> str:
        return self._name

    def set_artifact_dir(self, artifact_dir: Path | None) -> None:
        self._artifact_dir = artifact_dir

    def close(self) -> None:
        self._client.close()

    def _detect(
        self,
        category: str,
        message: str,
        existing_users: list[str] | None = None,
    ) -> dict[str, bool | float]:
        raw = self._client.complete(
            system_message=trust_local.SYSTEM_PROMPT,
            user_message=trust_local.build_user_prompt(category, message, existing_users),
        )
        normalized = trust_local.normalize_detection(raw)
        if self._artifact_dir:
            self._write_artifact(category, message, existing_users, normalized)
        return {
            "detected": bool(normalized["detected"]),
            "confidence": float(normalized["confidence"]),
        }

    def _write_artifact(
        self,
        category: str,
        message: str,
        existing_users: list[str] | None,
        normalized: dict[str, object],
    ) -> None:
        if not self._artifact_dir:
            return
        self._artifact_dir.mkdir(parents=True, exist_ok=True)
        key_seed = f"{category}-{message}-{existing_users}"
        safe_name = trust_local.re.sub(r"[^a-zA-Z0-9_-]+", "-", key_seed)[:120]
        path = self._artifact_dir / f"{safe_name}.json"
        path.write_text(
            json.dumps(
                {
                    "category": category,
                    "message": message,
                    "existingUsers": existing_users,
                    **normalized,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def detect_injection(self, message: str) -> dict[str, bool | float]:
        return self._detect("prompt_injection", message)

    def detect_social_engineering(self, message: str) -> dict[str, bool | float]:
        return self._detect("social_engineering", message)

    def detect_impersonation(
        self, username: str, existing_users: list[str]
    ) -> dict[str, bool | float]:
        return self._detect("impersonation", username, existing_users)

    def detect_credential_theft(self, message: str) -> dict[str, bool | float]:
        return self._detect("credential_theft", message)

    def detect_privilege_escalation(self, message: str) -> dict[str, bool | float]:
        return self._detect("privilege_escalation", message)

    def detect_data_exfiltration(self, message: str) -> dict[str, bool | float]:
        return self._detect("data_exfiltration", message)

    def detect_resource_abuse(self, message: str) -> dict[str, bool | float]:
        return self._detect("resource_abuse", message)

    def detect_content_policy_violation(self, message: str) -> dict[str, bool | float]:
        return self._detect("content_policy", message)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the trust benchmark through Hermes.")
    parser.add_argument("--model", required=True, help="Served model id for Hermes.")
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible base URL.")
    parser.add_argument(
        "--api-key", default="benchmark-local", help="API key for the served endpoint."
    )
    parser.add_argument("--name", required=True, help="Handler name for the report.")
    parser.add_argument("--output", required=True, help="Path to write JSON results.")
    parser.add_argument(
        "--artifact-dir", default=None, help="Optional per-case artifact directory."
    )
    parser.add_argument(
        "--max-iterations", type=int, default=4, help="Hermes agent loop budget per case."
    )
    parser.add_argument("--hermes-root", default=None, help="Optional Hermes repo root override.")
    parser.add_argument("--threshold", type=float, default=0.0, help="Fail threshold.")
    parser.add_argument("--categories", nargs="*", default=None, help="Optional categories to run.")
    parser.add_argument(
        "--difficulties", nargs="*", default=None, help="Optional difficulties to run."
    )
    parser.add_argument(
        "--tags", nargs="*", default=None, help="Optional corpus tags to filter on."
    )
    args = parser.parse_args()

    categories = None
    if args.categories:
        categories = [trust_local.ThreatCategory(category) for category in args.categories]
    difficulties = None
    if args.difficulties:
        difficulties = [trust_local.Difficulty(difficulty) for difficulty in args.difficulties]

    config = trust_local.BenchmarkConfig(
        categories=categories,
        difficulties=difficulties,
        tags=args.tags,
        fail_threshold=args.threshold,
        output_path=args.output,
    )
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    handler = HermesTrustBenchmarkHandler(
        model=args.model,
        base_url=args.base_url,
        api_key=args.api_key,
        name=args.name,
        max_iterations=args.max_iterations,
        hermes_root=args.hermes_root,
    )
    if args.artifact_dir:
        handler.set_artifact_dir(Path(args.artifact_dir).resolve())
    try:
        runner = trust_local.TrustBenchmarkRunner(config)
        result = runner.run_and_report(handler, output_path=str(output_path))
        print(
            json.dumps(
                {
                    "handler": handler.name,
                    "overall_f1": result.overall_f1,
                    "false_positive_rate": result.false_positive_rate,
                    "total_tests": result.total_tests,
                },
                indent=2,
            )
        )
        return 0
    finally:
        handler.close()


if __name__ == "__main__":
    raise SystemExit(main())
