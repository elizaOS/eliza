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
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from elizaos_gaia.harness import (
    harness_env_updates,
    normalize_harness_label,
    resolve_harness,
)
from elizaos_gaia.runner import run_quick_test
from elizaos_gaia.trajectory import write_trajectory_artifacts
from elizaos_gaia.types import GAIAConfig

_RESEARCH_CAPABILITIES = {
    "research.web_search",
    "research.web_browse",
    "research.docs_lookup",
}
_LEGACY_PROVIDER_DEFAULTS = ("claude-code", "swe-agent", "codex")
_OPENAI_COMPATIBLE_API_BASE = "https://api.cerebras.ai/v1"

DEFAULT_PROVIDER_CAPABILITIES: dict[str, set[str]] = {
    "claude-code": set(_RESEARCH_CAPABILITIES),
    "codex": set(_RESEARCH_CAPABILITIES),
    "swe-agent": set(_RESEARCH_CAPABILITIES),
    "eliza": set(_RESEARCH_CAPABILITIES),
    "hermes": set(_RESEARCH_CAPABILITIES),
    "openclaw": set(_RESEARCH_CAPABILITIES),
}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run GAIA through an orchestrated provider matrix")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="openai/gpt-oss-120b")
    parser.add_argument("--dataset", choices=["sample", "gaia", "jsonl"], default="sample")
    parser.add_argument("--dataset-path", default=None)
    parser.add_argument("--max-questions", type=int, default=1)
    parser.add_argument("--providers", nargs="+", default=["eliza", "hermes", "openclaw"])
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


def _normalize_harness_label(value: str | None) -> str | None:
    return normalize_harness_label(value)


def _current_harness() -> str | None:
    for env_name in ("ELIZA_BENCH_HARNESS", "BENCHMARK_HARNESS", "BENCHMARK_AGENT"):
        harness = _normalize_harness_label(os.environ.get(env_name))
        if harness:
            return harness
    return None


def _effective_provider_labels(providers: list[str]) -> list[str]:
    requested = [provider.strip() for provider in providers if provider.strip()]
    if not requested:
        return [_current_harness() or "eliza"]

    inherited_harness = _current_harness()
    if inherited_harness and tuple(requested) == _LEGACY_PROVIDER_DEFAULTS:
        return [inherited_harness]

    effective: list[str] = []
    for provider in requested:
        effective.append(_normalize_harness_label(provider) or provider)
    return effective


def _provider_harness(provider_label: str) -> str:
    return _normalize_harness_label(provider_label) or _current_harness() or "eliza"


def _model_provider_for_config(harness: str | None = None) -> str:
    configured = (
        os.environ.get("BENCHMARK_MODEL_PROVIDER")
        or os.environ.get("ELIZA_PROVIDER")
        or ""
    ).strip().lower()
    if configured:
        return "openai" if configured == "cerebras" else configured
    return "eliza" if harness == "eliza" else "openai"


def _model_api_base_for_config(harness: str | None = None) -> str | None:
    if harness == "eliza":
        return None
    configured = (
        os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("OPENAI_API_BASE")
        or ""
    ).strip()
    if configured:
        return configured
    return _OPENAI_COMPATIBLE_API_BASE


def _model_env_updates(
    model_name: str,
    harness: str,
    telemetry_path: Path,
    model_provider: str,
    model_api_base: str | None,
) -> dict[str, str]:
    updates = {
        "BENCHMARK_TELEMETRY_JSONL": str(telemetry_path),
        "BENCHMARK_MODEL_PROVIDER": model_provider,
        "ELIZA_PROVIDER": model_provider,
        "BENCHMARK_MODEL_NAME": model_name,
        "MODEL_NAME": model_name,
        "OPENAI_MODEL": model_name,
        "OPENAI_LARGE_MODEL": model_name,
        "OPENAI_SMALL_MODEL": model_name,
        "GROQ_LARGE_MODEL": model_name,
        "GROQ_SMALL_MODEL": model_name,
        "OPENROUTER_LARGE_MODEL": model_name,
        "OPENROUTER_SMALL_MODEL": model_name,
        "CEREBRAS_MODEL": model_name,
        "CEREBRAS_LARGE_MODEL": model_name,
        "CEREBRAS_SMALL_MODEL": model_name,
    }
    updates.update(harness_env_updates(resolve_harness(explicit=harness)))
    if model_api_base:
        updates["OPENAI_BASE_URL"] = model_api_base
        updates["OPENAI_API_BASE"] = model_api_base
    return updates


@contextmanager
def _patched_env(updates: Mapping[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in updates}
    try:
        for key, value in updates.items():
            os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _positive_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int | float):
        return int(value) if value > 0 else 0
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return 0
        return int(parsed) if parsed > 0 else 0
    return 0


def _usage_total_tokens(usage: Mapping[str, object]) -> int:
    total = _positive_int(
        usage.get("total_tokens")
        or usage.get("totalTokens")
        or usage.get("total")
    )
    if total > 0:
        return total

    prompt_details = usage.get("prompt_tokens_details")
    details = prompt_details if isinstance(prompt_details, Mapping) else {}
    return sum(
        _positive_int(value)
        for value in (
            usage.get("prompt_tokens"),
            usage.get("promptTokens"),
            usage.get("input_tokens"),
            usage.get("completion_tokens"),
            usage.get("completionTokens"),
            usage.get("output_tokens"),
            usage.get("cache_read_input_tokens"),
            usage.get("cachedTokens"),
            usage.get("cached_tokens"),
            details.get("cached_tokens"),
            usage.get("cache_creation_input_tokens"),
            usage.get("cache_write_tokens"),
            details.get("cache_write_tokens"),
        )
    )


def _telemetry_record_tokens(record: Mapping[str, object]) -> int:
    direct = _positive_int(record.get("total_tokens"))
    if direct > 0:
        return direct
    usage = record.get("usage")
    if isinstance(usage, Mapping):
        return _usage_total_tokens(usage)
    return sum(
        _positive_int(record.get(key))
        for key in ("prompt_tokens", "completion_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    )


def _read_telemetry_summary(path: Path) -> dict[str, object]:
    summary: dict[str, object] = {
        "path": str(path),
        "records": 0,
        "records_with_tokens": 0,
        "total_tokens": 0,
        "errors": 0,
    }
    if not path.exists():
        return summary

    records = 0
    records_with_tokens = 0
    total_tokens = 0
    errors = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, Mapping):
            continue
        records += 1
        token_count = _telemetry_record_tokens(record)
        if token_count > 0:
            records_with_tokens += 1
            total_tokens += token_count
        if record.get("error_if_any"):
            errors += 1

    summary["records"] = records
    summary["records_with_tokens"] = records_with_tokens
    summary["total_tokens"] = total_tokens
    summary["errors"] = errors
    return summary


def _is_timeout_error(error: object) -> bool:
    return isinstance(error, str) and "timeout" in error.lower()


def _run_validation_error(
    results: object,
    telemetry_summary: Mapping[str, object],
) -> str | None:
    metrics = getattr(results, "metrics", None)
    total_questions = _positive_int(getattr(metrics, "total_questions", 0))
    if total_questions <= 0:
        return "no_questions"

    rows = list(getattr(results, "results", []) or [])
    if rows and all(_is_timeout_error(getattr(row, "error", None)) for row in rows):
        return "all_timeout"

    metrics_tokens = _positive_int(getattr(metrics, "total_tokens", 0))
    telemetry_tokens = _positive_int(telemetry_summary.get("total_tokens"))
    if max(metrics_tokens, telemetry_tokens) <= 0:
        return "zero_tokens"
    return None


def _needs_eliza_server(provider_labels: list[str]) -> bool:
    return any(_provider_harness(provider) == "eliza" for provider in provider_labels)


async def _run_provider(args: argparse.Namespace, provider_label: str) -> dict[str, object]:
    harness = _provider_harness(provider_label)
    provider_output = Path(args.output) / provider_label
    provider_output.mkdir(parents=True, exist_ok=True)
    telemetry_path = provider_output / "telemetry.jsonl"
    if telemetry_path.exists():
        telemetry_path.unlink()

    config = GAIAConfig(
        output_dir=str(provider_output),
        dataset_source=args.dataset,
        dataset_path=args.dataset_path,
        max_questions=args.max_questions,
        model_name=args.model,
        provider=_model_provider_for_config(harness),
        harness=harness,
        api_base=_model_api_base_for_config(harness),
        temperature=args.temperature,
        compare_leaderboard=False,
        include_model_in_output=True,
    )
    model_provider = _model_provider_for_config(harness)
    model_api_base = _model_api_base_for_config(harness)
    with _patched_env(
        _model_env_updates(
            args.model,
            harness,
            telemetry_path,
            model_provider,
            model_api_base,
        )
    ):
        config.provider = model_provider
        config.api_base = model_api_base
        results = await run_quick_test(
            config,
            num_questions=args.max_questions,
            hf_token=os.environ.get("HF_TOKEN"),
        )
    telemetry_summary = _read_telemetry_summary(telemetry_path)
    trajectory_paths = write_trajectory_artifacts(
        results,
        provider_output,
        timestamp=datetime.now().strftime("%Y%m%d_%H%M%S"),
        run_kind="gaia_orchestrated",
        latest=True,
    )
    metrics = results.metrics
    validation_error = _run_validation_error(results, telemetry_summary)
    payload: dict[str, object] = {
        "provider": provider_label,
        "harness": harness,
        "metadata": {
            **dict(results.metadata),
            "provider_label": provider_label,
            "benchmark_harness": harness,
            "model_provider": model_provider,
            "model_api_base": model_api_base,
            "harness_backend": resolve_harness(explicit=harness).backend,
        },
        "metrics": {
            "overall_accuracy": metrics.overall_accuracy,
            "total_questions": metrics.total_questions,
            "correct_answers": metrics.correct_answers,
            "incorrect_answers": metrics.incorrect_answers,
            "errors": metrics.errors,
            "total_tokens": metrics.total_tokens,
            "observed_total_tokens": max(
                _positive_int(metrics.total_tokens),
                _positive_int(telemetry_summary.get("total_tokens")),
            ),
        },
        "telemetry": telemetry_summary,
        "trajectory_artifacts": trajectory_paths,
        "validation": {
            "ok": validation_error is None,
            "failure": validation_error,
        },
    }
    if validation_error is not None:
        payload["error"] = (
            f"Invalid GAIA run for provider={provider_label} harness={harness}: "
            f"{validation_error}"
        )
    return payload


async def _main() -> int:
    args = _parse_args()
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    server_mgr = None
    providers = _effective_provider_labels(args.providers)

    try:
        if _needs_eliza_server(providers) and not os.environ.get("ELIZA_BENCH_URL"):
            from eliza_adapter.server_manager import ElizaServerManager

            server_mgr = ElizaServerManager()
            server_mgr.start()
            os.environ["ELIZA_BENCH_TOKEN"] = server_mgr.token
            os.environ.setdefault("ELIZA_BENCH_URL", f"http://localhost:{server_mgr.port}")

        required = _parse_required_capabilities(args.required_capabilities)
        capability_reports = {
            provider: _capability_report(provider, required)
            for provider in providers
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
                        "providers": providers,
                        "requested_providers": args.providers,
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
        total_tokens = 0
        invalid_providers: dict[str, str] = {}
        for provider in providers:
            provider_result = await _run_provider(args, provider)
            provider_payloads[provider] = provider_result
            metrics = provider_result["metrics"]
            assert isinstance(metrics, dict)
            validation = provider_result.get("validation")
            if isinstance(validation, dict) and validation.get("ok") is False:
                invalid_providers[provider] = str(validation.get("failure") or "invalid_run")
            score = float(metrics.get("overall_accuracy") or 0.0)
            provider_scores[provider] = score
            total_questions += int(metrics.get("total_questions") or 0)
            total_correct += int(metrics.get("correct_answers") or 0)
            total_tokens += int(metrics.get("observed_total_tokens") or metrics.get("total_tokens") or 0)

        matrix = {
            "execution_mode": args.execution_mode,
            "providers": providers,
            "requested_providers": args.providers,
            "required_capabilities": required,
            "strict_capabilities": args.strict_capabilities,
            "capabilities": capability_reports,
        }

        if invalid_providers:
            payload = {
                "error": f"Invalid GAIA orchestrated run: {invalid_providers}",
                "matrix": matrix,
                "orchestrated": provider_payloads,
            }
            out_path = output_dir / "gaia-orchestrated-latest.json"
            out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            print(payload["error"])
            print(f"Result file: {out_path}")
            return 2

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
                "total_tokens": total_tokens,
                "provider_scores": provider_scores,
            },
            "matrix": matrix,
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
