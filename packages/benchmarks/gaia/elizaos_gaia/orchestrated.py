"""Orchestrated GAIA matrix runner.

This entry point keeps the underlying GAIA task execution on the elizaOS
TypeScript benchmark bridge, but wraps it in the same provider-matrix shape as
the orchestrator benchmark tracks. Provider labels represent control-plane
providers; the bridge owns the actual model runtime.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from elizaos_gaia.runner import run_quick_test
from elizaos_gaia.types import GAIAConfig


DEFAULT_PROVIDER_CAPABILITIES: dict[str, set[str]] = {
    "claude-code": {"research.web_search", "research.web_browse", "research.docs_lookup"},
    "codex": {"research.web_search", "research.web_browse", "research.docs_lookup"},
    "swe-agent": {"research.web_search", "research.web_browse", "research.docs_lookup"},
}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run GAIA through an orchestrated provider matrix")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="openai/gpt-oss-120b")
    parser.add_argument("--dataset", choices=["sample", "gaia", "jsonl"], default="sample")
    parser.add_argument("--dataset-path", default=None)
    parser.add_argument("--max-questions", type=int, default=1)
    parser.add_argument("--providers", nargs="+", default=["claude-code", "swe-agent", "codex"])
    parser.add_argument("--execution-mode", default="orchestrated")
    parser.add_argument("--matrix", action="store_true")
    parser.add_argument("--strict-capabilities", action="store_true")
    parser.add_argument("--required-capabilities", nargs="*", default=[])
    parser.add_argument("--temperature", type=float, default=0.0)
    return parser.parse_args()


def _capability_report(provider: str, required: list[str]) -> dict[str, object]:
    available = DEFAULT_PROVIDER_CAPABILITIES.get(provider, set())
    missing = [capability for capability in required if capability not in available]
    return {
        "provider": provider,
        "required": required,
        "available": sorted(available),
        "missing": missing,
        "satisfied": not missing,
    }


def _parse_required_capabilities(values: list[str]) -> list[str]:
    required: list[str] = []
    seen: set[str] = set()
    for raw_value in values:
        for capability in str(raw_value).split(","):
            normalized = capability.strip()
            if normalized and normalized not in seen:
                required.append(normalized)
                seen.add(normalized)
    return required


async def _run_provider(args: argparse.Namespace, provider_label: str) -> dict[str, object]:
    provider_output = Path(args.output) / provider_label
    provider_output.mkdir(parents=True, exist_ok=True)
    config = GAIAConfig(
        output_dir=str(provider_output),
        dataset_source=args.dataset,
        dataset_path=args.dataset_path,
        max_questions=args.max_questions,
        model_name=args.model,
        provider="eliza",
        temperature=args.temperature,
        compare_leaderboard=False,
        include_model_in_output=True,
    )
    results = await run_quick_test(
        config,
        num_questions=args.max_questions,
        hf_token=os.environ.get("HF_TOKEN"),
    )
    metrics = results.metrics
    return {
        "provider": provider_label,
        "metadata": dict(results.metadata),
        "metrics": {
            "overall_accuracy": metrics.overall_accuracy,
            "total_questions": metrics.total_questions,
            "correct_answers": metrics.correct_answers,
            "incorrect_answers": metrics.incorrect_answers,
            "errors": metrics.errors,
        },
    }


async def _main() -> int:
    args = _parse_args()
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    server_mgr = None

    try:
        if not os.environ.get("ELIZA_BENCH_URL"):
            from eliza_adapter.server_manager import ElizaServerManager

            server_mgr = ElizaServerManager()
            server_mgr.start()
            os.environ["ELIZA_BENCH_TOKEN"] = server_mgr.token
            os.environ.setdefault("ELIZA_BENCH_URL", f"http://localhost:{server_mgr.port}")

        required = _parse_required_capabilities(args.required_capabilities)
        capability_reports = {
            provider: _capability_report(provider, required)
            for provider in args.providers
        }
        if args.strict_capabilities:
            missing = {
                provider: report["missing"]
                for provider, report in capability_reports.items()
                if report["missing"]
            }
            if missing:
                payload = {
                    "metrics": {
                        "overall_accuracy": 0.0,
                        "total_questions": 0,
                        "correct_answers": 0,
                    },
                    "matrix": {
                        "execution_mode": args.execution_mode,
                        "providers": args.providers,
                        "required_capabilities": required,
                        "strict_capabilities": True,
                        "capabilities": capability_reports,
                    },
                    "error": f"Missing required capabilities: {missing}",
                }
                out_path = output_dir / "gaia-orchestrated-latest.json"
                out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
                return 2

        provider_payloads: dict[str, dict[str, object]] = {}
        provider_scores: dict[str, float] = {}
        total_questions = 0
        total_correct = 0
        for provider in args.providers:
            provider_result = await _run_provider(args, provider)
            provider_payloads[provider] = provider_result
            metrics = provider_result["metrics"]
            assert isinstance(metrics, dict)
            score = float(metrics.get("overall_accuracy") or 0.0)
            provider_scores[provider] = score
            total_questions += int(metrics.get("total_questions") or 0)
            total_correct += int(metrics.get("correct_answers") or 0)

        overall = (
            sum(provider_scores.values()) / len(provider_scores)
            if provider_scores
            else 0.0
        )
        payload = {
            "metrics": {
                "overall_accuracy": overall,
                "total_questions": total_questions,
                "correct_answers": total_correct,
                "provider_scores": provider_scores,
            },
            "matrix": {
                "execution_mode": args.execution_mode,
                "providers": args.providers,
                "required_capabilities": required,
                "strict_capabilities": args.strict_capabilities,
                "capabilities": capability_reports,
            },
            "orchestrated": provider_payloads,
        }
        out_path = output_dir / "gaia-orchestrated-latest.json"
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(json.dumps(payload["metrics"], indent=2))
        print(f"Result file: {out_path}")
        return 0
    finally:
        if server_mgr is not None:
            server_mgr.stop()


def main() -> None:
    raise SystemExit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
