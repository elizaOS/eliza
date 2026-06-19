#!/usr/bin/env python3
"""
Compare the base MLX model against a trained adapter over the local HTTP server.

This is a deterministic post-train demonstration harness. It starts the base
model and the adapter-backed model sequentially, sends the same fixed prompt
set to both with temperature 0, scores the outputs with lightweight structural
checks, and saves a side-by-side JSON report.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "training"))

from deterministic_eval import (
    ACTION_REASON_ASSISTANT_PREFIX,
    ACTION_REASON_PROMPTS,
    ACTION_REASON_SYSTEM_PROMPT,
    DECISION_FORMAT_SYSTEM_PROMPT,
    DECISION_VALIDATION_PROMPTS,
    NATURAL_MESSAGE_SYSTEM_PROMPT,
    score_action_reason_response,
    score_decision_response,
    summarize_action_reason_results,
    summarize_decision_results,
)

DEFAULT_SYSTEM_PROMPT = ACTION_REASON_SYSTEM_PROMPT
DEFAULT_PROMPTS = ACTION_REASON_PROMPTS
DECISION_MAX_TOKENS = 220


def _action_reason_suite(
    prompts: Sequence[dict[str, Any]] | None = None,
    *,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    max_tokens: int = 120,
) -> dict[str, Any]:
    return {
        "name": "action_reason",
        "system_prompt": system_prompt,
        "prompts": [dict(prompt) for prompt in (prompts or DEFAULT_PROMPTS)],
        "max_tokens": max_tokens,
        "assistant_prefix": ACTION_REASON_ASSISTANT_PREFIX,
        "score_fn": score_action_reason_response,
        "summarize_fn": summarize_action_reason_results,
    }


def _decision_suite() -> dict[str, Any]:
    return {
        "name": "decision_format",
        "system_prompt": DECISION_FORMAT_SYSTEM_PROMPT,
        "prompts": [dict(prompt) for prompt in DECISION_VALIDATION_PROMPTS],
        "max_tokens": DECISION_MAX_TOKENS,
        "assistant_prefix": None,
        "score_fn": score_decision_response,
        "summarize_fn": summarize_decision_results,
    }


def _natural_message_suite() -> dict[str, Any]:
    return {
        "name": "natural_message",
        "system_prompt": NATURAL_MESSAGE_SYSTEM_PROMPT,
        "prompts": [dict(prompt) for prompt in DECISION_VALIDATION_PROMPTS],
        "max_tokens": 140,
        "assistant_prefix": None,
        "score_fn": score_decision_response,
        "summarize_fn": summarize_decision_results,
    }


def build_suite_configs(
    *,
    prompts: Sequence[dict[str, Any]] | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    max_tokens: int = 120,
    include_decision_suite: bool = True,
) -> list[dict[str, Any]]:
    suites = [_action_reason_suite(prompts, system_prompt=system_prompt, max_tokens=max_tokens)]
    if prompts is None and system_prompt == DEFAULT_SYSTEM_PROMPT and include_decision_suite:
        suites.append(_natural_message_suite())
        suites.append(_decision_suite())
    return suites


def _summary_prompt_count(summary: dict[str, Any]) -> int:
    try:
        return int(summary.get("prompt_count", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _summary_format_rate(summary: dict[str, Any]) -> float | None:
    for key in ("format_rate", "json_format_rate", "valid_action_rate"):
        value = summary.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def aggregate_suite_summaries(
    suite_summaries: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    total_prompts = sum(_summary_prompt_count(summary) for summary in suite_summaries.values())
    if total_prompts <= 0:
        return {"prompt_count": 0, "suite_breakdown": suite_summaries}

    weighted_score = 0.0
    weighted_latency = 0.0
    weighted_format = 0.0
    format_weight = 0

    for summary in suite_summaries.values():
        prompt_count = _summary_prompt_count(summary)
        if prompt_count <= 0:
            continue
        weighted_score += float(summary.get("avg_score", 0.0) or 0.0) * prompt_count
        weighted_latency += float(summary.get("avg_latency_ms", 0.0) or 0.0) * prompt_count
        format_rate = _summary_format_rate(summary)
        if format_rate is not None:
            weighted_format += format_rate * prompt_count
            format_weight += prompt_count

    aggregate = {
        "prompt_count": total_prompts,
        "avg_score": round(weighted_score / total_prompts, 4),
        "avg_latency_ms": round(weighted_latency / total_prompts, 1),
        "suite_breakdown": suite_summaries,
    }
    if format_weight > 0:
        aggregate["format_rate"] = round(weighted_format / format_weight, 4)
    return aggregate


def flatten_suite_prompts(suites: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for suite in suites:
        suite_name = str(suite.get("name") or "suite")
        for prompt in suite.get("prompts", []):
            if not isinstance(prompt, dict):
                continue
            flattened.append({"suite": suite_name, **dict(prompt)})
    return flattened


def flatten_suite_results(
    suite_variants: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for suite_name, variant in suite_variants.items():
        for result in variant.get("results", []):
            if not isinstance(result, dict):
                continue
            normalized = dict(result)
            normalized["suite"] = suite_name
            normalized["prompt_id"] = f"{suite_name}:{result['prompt_id']}"
            flattened.append(normalized)
    return flattened


def aggregate_variant_suites(
    *,
    suite_variants: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    first_variant = next(iter(suite_variants.values()))
    suite_summaries = {
        suite_name: dict(variant.get("summary") or {})
        for suite_name, variant in suite_variants.items()
    }
    return {
        "label": first_variant.get("label"),
        "model_name": first_variant.get("model_name"),
        "adapter_path": first_variant.get("adapter_path"),
        "served_model_id": first_variant.get("served_model_id"),
        "served_model_ids": {
            suite_name: variant.get("served_model_id")
            for suite_name, variant in suite_variants.items()
        },
        "summary": aggregate_suite_summaries(suite_summaries),
        "results": flatten_suite_results(suite_variants),
        "suite_results": suite_variants,
    }


def load_manifest(manifest_path: Path) -> tuple[str, str]:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    model_name = manifest.get("model_name")
    adapter_path = manifest.get("output_path")
    if not model_name or not adapter_path:
        raise ValueError(f"Manifest {manifest_path} is missing model_name or output_path")

    return str(model_name), str(adapter_path)


def load_prompts(prompt_file: str | None) -> list[dict[str, str]]:
    if prompt_file is None:
        return [dict(prompt) for prompt in DEFAULT_PROMPTS]

    with Path(prompt_file).open("r", encoding="utf-8") as handle:
        raw_prompts = json.load(handle)

    prompts: list[dict[str, str]] = []
    for index, item in enumerate(raw_prompts):
        if isinstance(item, str):
            prompts.append({"id": f"prompt-{index + 1}", "prompt": item})
            continue

        prompt_id = item.get("id") or f"prompt-{index + 1}"
        prompt_text = item.get("prompt")
        if not prompt_text:
            raise ValueError(f"Prompt entry {index} is missing 'prompt'")
        prompt_payload = {key: value for key, value in item.items() if key not in {"id", "prompt"}}
        prompts.append(
            {
                "id": str(prompt_id),
                "prompt": str(prompt_text),
                **prompt_payload,
            }
        )

    return prompts


def build_api_url(base_url: str, endpoint_path: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/v1"):
        return f"{normalized}{endpoint_path}"
    return f"{normalized}/v1{endpoint_path}"


def auth_headers(api_key: str | None) -> dict[str, str]:
    if not api_key:
        return {}
    return {"Authorization": f"Bearer {api_key}"}


def request_json(
    url: str,
    payload: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
    timeout_seconds: int = 60,
) -> dict[str, Any]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)

    request = Request(url, data=data, headers=headers)
    with urlopen(request, timeout=timeout_seconds) as response:
        return json.load(response)


def remaining_timeout_seconds(deadline: float) -> int:
    remaining = int(deadline - time.time())
    if remaining <= 0:
        raise TimeoutError("Served comparison exceeded its deadline")
    return remaining


def wait_for_server(
    base_url: str,
    timeout_seconds: int,
    api_key: str | None = None,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            return request_json(
                build_api_url(base_url, "/models"),
                extra_headers=auth_headers(api_key),
                timeout_seconds=min(10, timeout_seconds),
            )
        except Exception as exc:
            last_error = exc
            time.sleep(1)

    raise TimeoutError(f"Timed out waiting for MLX server at {base_url}: {last_error}")


def terminate_process(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return

    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def pick_served_model_id(models_response: dict[str, Any], fallback: str) -> str:
    models = models_response.get("data")
    if isinstance(models, list) and models:
        first = models[0]
        if isinstance(first, dict) and isinstance(first.get("id"), str):
            return first["id"]
    return fallback


def extract_completion_text(completion: dict[str, Any]) -> str:
    choices = completion.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    message = choices[0].get("message", {})
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    return ""


def normalize_text(text: str) -> str:
    return " ".join(text.lower().split())


def score_response_text(
    response_text: str,
    prompt_spec: dict[str, Any] | None = None,
    suite_type: str = "action_reason",
) -> dict[str, Any]:
    if suite_type in {"decision_format", "natural_message"}:
        return score_decision_response(response_text, prompt_spec=prompt_spec)
    return score_action_reason_response(response_text, prompt_spec=prompt_spec)


def summarize_results(
    results: Sequence[dict[str, Any]],
    suite_type: str = "action_reason",
) -> dict[str, Any]:
    if suite_type in {"decision_format", "natural_message"}:
        return summarize_decision_results(results)
    return summarize_action_reason_results(results)


def update_manifest_with_report(
    manifest_path: Path,
    output_path: Path,
    report: dict[str, Any],
) -> None:
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    manifest["served_evaluation"] = {
        "report_path": str(output_path),
        "generated_at": report["timestamp"],
        "base_summary": report["base_model"]["summary"],
        "adapter_summary": report["adapter_model"]["summary"],
        "base_suite_summaries": {
            name: suite_report.get("summary")
            for name, suite_report in (report["base_model"].get("suite_results") or {}).items()
        },
        "adapter_suite_summaries": {
            name: suite_report.get("summary")
            for name, suite_report in (report["adapter_model"].get("suite_results") or {}).items()
        },
        "comparison": report["comparison"],
    }

    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)


def compare_variant_results(
    base_results: Sequence[dict[str, Any]],
    adapter_results: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    if len(base_results) != len(adapter_results):
        raise ValueError("Base and adapter results must cover the same prompt set")

    base_by_id = {result["prompt_id"]: result for result in base_results}
    adapter_by_id = {result["prompt_id"]: result for result in adapter_results}
    prompt_ids = list(base_by_id.keys())

    distinct_responses = 0
    adapter_wins = 0
    base_wins = 0
    ties = 0
    per_prompt = []

    for prompt_id in prompt_ids:
        base_result = base_by_id[prompt_id]
        adapter_result = adapter_by_id[prompt_id]

        same_response = normalize_text(base_result["response"]) == normalize_text(
            adapter_result["response"]
        )
        if not same_response:
            distinct_responses += 1

        base_score = base_result["score"]["score"]
        adapter_score = adapter_result["score"]["score"]
        if adapter_score > base_score:
            adapter_wins += 1
        elif base_score > adapter_score:
            base_wins += 1
        else:
            ties += 1

        per_prompt.append(
            {
                "prompt_id": prompt_id,
                "base_score": base_score,
                "adapter_score": adapter_score,
                "score_delta": round(adapter_score - base_score, 4),
                "responses_differ": not same_response,
            }
        )

    base_avg_score = (
        sum(float(result.get("score", {}).get("score", 0.0)) for result in base_results)
        / len(base_results)
        if base_results
        else 0.0
    )
    adapter_avg_score = (
        sum(float(result.get("score", {}).get("score", 0.0)) for result in adapter_results)
        / len(adapter_results)
        if adapter_results
        else 0.0
    )
    base_avg_latency = (
        sum(float(result.get("latency_ms", 0.0)) for result in base_results) / len(base_results)
        if base_results
        else 0.0
    )
    adapter_avg_latency = (
        sum(float(result.get("latency_ms", 0.0)) for result in adapter_results)
        / len(adapter_results)
        if adapter_results
        else 0.0
    )

    return {
        "distinct_response_count": distinct_responses,
        "adapter_wins": adapter_wins,
        "base_wins": base_wins,
        "ties": ties,
        "avg_score_delta": round(adapter_avg_score - base_avg_score, 4),
        "avg_latency_delta_ms": round(adapter_avg_latency - base_avg_latency, 1),
        "per_prompt": per_prompt,
    }


def start_server(
    model_name: str,
    adapter_path: str | None,
    host: str,
    port: int,
    max_tokens: int,
) -> subprocess.Popen[str]:
    command = [
        sys.executable,
        "-m",
        "mlx_lm",
        "server",
        "--model",
        model_name,
        "--host",
        host,
        "--port",
        str(port),
        "--max-tokens",
        str(max_tokens),
    ]
    if adapter_path:
        command.extend(["--adapter-path", adapter_path])

    return subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def start_tinker_proxy(
    model_ref: str,
    host: str,
    port: int,
    served_name: str,
    max_tokens: int,
) -> subprocess.Popen[str]:
    command = [
        sys.executable,
        str(Path(__file__).with_name("tinker_openai_proxy.py")),
        "--model-ref",
        model_ref,
        "--host",
        host,
        "--port",
        str(port),
        "--served-model-name",
        served_name,
        "--max-tokens",
        str(max_tokens),
    ]
    return subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def query_prompt(
    base_url: str,
    served_model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    prompt_spec: dict[str, Any] | None = None,
    api_key: str | None = None,
    assistant_prefix: str | None = None,
    timeout_seconds: int = 60,
    score_fn=score_response_text,
) -> dict[str, Any]:
    payload = {
        "model": served_model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.0,
        "max_tokens": max_tokens,
    }
    if assistant_prefix is not None:
        payload["assistant_prefix"] = assistant_prefix

    start = time.perf_counter()
    completion = request_json(
        build_api_url(base_url, "/chat/completions"),
        payload,
        extra_headers=auth_headers(api_key),
        timeout_seconds=timeout_seconds,
    )
    latency_ms = (time.perf_counter() - start) * 1000
    response_text = extract_completion_text(completion)

    return {
        "response": response_text,
        "latency_ms": round(latency_ms, 1),
        "raw_completion": completion,
        "score": score_fn(response_text, prompt_spec),
    }


def evaluate_model_variant(
    *,
    label: str,
    model_name: str,
    adapter_path: str | None,
    prompts: Sequence[dict[str, str]],
    system_prompt: str,
    host: str,
    port: int,
    timeout: int,
    max_tokens: int,
    assistant_prefix: str | None = ACTION_REASON_ASSISTANT_PREFIX,
    score_fn=score_response_text,
    summarize_fn=summarize_results,
) -> dict[str, Any]:
    base_url = f"http://{host}:{port}"
    proc = start_server(model_name, adapter_path, host, port, max_tokens)
    deadline = time.time() + timeout

    try:
        models = wait_for_server(base_url, remaining_timeout_seconds(deadline))
        served_model_id = pick_served_model_id(models, model_name)

        results = []
        for prompt in prompts:
            query_result = query_prompt(
                base_url,
                served_model_id,
                system_prompt,
                prompt["prompt"],
                max_tokens,
                prompt_spec=prompt,
                assistant_prefix=assistant_prefix,
                timeout_seconds=remaining_timeout_seconds(deadline),
                score_fn=score_fn,
            )
            results.append(
                {
                    "prompt_id": prompt["id"],
                    "prompt": prompt["prompt"],
                    "slice": prompt.get("slice"),
                    **query_result,
                }
            )

        return {
            "label": label,
            "model_name": model_name,
            "adapter_path": adapter_path,
            "served_model_id": served_model_id,
            "summary": summarize_fn(results),
            "results": results,
        }
    finally:
        terminate_process(proc)


def evaluate_remote_model_variant(
    *,
    label: str,
    model_ref: str,
    prompts: Sequence[dict[str, str]],
    system_prompt: str,
    base_url: str,
    timeout: int,
    max_tokens: int,
    api_key: str,
    assistant_prefix: str | None = ACTION_REASON_ASSISTANT_PREFIX,
    score_fn=score_response_text,
    summarize_fn=summarize_results,
) -> dict[str, Any]:
    deadline = time.time() + timeout
    wait_for_server(base_url, remaining_timeout_seconds(deadline), api_key=api_key)

    results = []
    for prompt in prompts:
        query_result = query_prompt(
            base_url,
            model_ref,
            system_prompt,
            prompt["prompt"],
            max_tokens,
            prompt_spec=prompt,
            api_key=api_key,
            assistant_prefix=assistant_prefix,
            timeout_seconds=remaining_timeout_seconds(deadline),
            score_fn=score_fn,
        )
        results.append(
            {
                "prompt_id": prompt["id"],
                "prompt": prompt["prompt"],
                "slice": prompt.get("slice"),
                **query_result,
            }
        )

    return {
        "label": label,
        "model_name": model_ref,
        "adapter_path": None,
        "served_model_id": model_ref,
        "summary": summarize_fn(results),
        "results": results,
    }


def evaluate_tinker_proxy_variant(
    *,
    label: str,
    model_ref: str,
    prompts: Sequence[dict[str, str]],
    system_prompt: str,
    host: str,
    port: int,
    timeout: int,
    max_tokens: int,
    assistant_prefix: str | None = ACTION_REASON_ASSISTANT_PREFIX,
    score_fn=score_response_text,
    summarize_fn=summarize_results,
) -> dict[str, Any]:
    base_url = f"http://{host}:{port}"
    proc = start_tinker_proxy(model_ref, host, port, label, max_tokens)
    deadline = time.time() + timeout

    try:
        models = wait_for_server(base_url, remaining_timeout_seconds(deadline))
        served_model_id = pick_served_model_id(models, label)

        results = []
        for prompt in prompts:
            query_result = query_prompt(
                base_url,
                served_model_id,
                system_prompt,
                prompt["prompt"],
                max_tokens,
                prompt_spec=prompt,
                assistant_prefix=assistant_prefix,
                timeout_seconds=remaining_timeout_seconds(deadline),
                score_fn=score_fn,
            )
            results.append(
                {
                    "prompt_id": prompt["id"],
                    "prompt": prompt["prompt"],
                    "slice": prompt.get("slice"),
                    **query_result,
                }
            )

        return {
            "label": label,
            "model_name": model_ref,
            "adapter_path": None,
            "served_model_id": served_model_id,
            "summary": summarize_fn(results),
            "results": results,
        }
    finally:
        terminate_process(proc)


def _evaluate_variant_suites(
    suite_configs: Sequence[dict[str, Any]],
    evaluator,
    **common_kwargs: Any,
) -> dict[str, Any]:
    suite_variants: dict[str, dict[str, Any]] = {}
    for suite in suite_configs:
        suite_name = str(suite.get("name") or "suite")
        suite_variants[suite_name] = evaluator(
            prompts=suite["prompts"],
            system_prompt=suite["system_prompt"],
            max_tokens=int(suite["max_tokens"]),
            assistant_prefix=suite.get("assistant_prefix"),
            score_fn=suite["score_fn"],
            summarize_fn=suite["summarize_fn"],
            **common_kwargs,
        )
    return aggregate_variant_suites(suite_variants=suite_variants)


def generate_comparison_report(
    *,
    model_name: str,
    adapter_path: str,
    prompts: Sequence[dict[str, str]] | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    host: str = "127.0.0.1",
    base_port: int = 8094,
    adapter_port: int = 8095,
    timeout: int = 60,
    max_tokens: int = 120,
    include_decision_suite: bool = True,
    output_path: Path,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    suite_configs = build_suite_configs(
        prompts=list(prompts) if prompts is not None else None,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        include_decision_suite=include_decision_suite,
    )

    base_eval = _evaluate_variant_suites(
        suite_configs,
        evaluate_model_variant,
        label="base",
        model_name=model_name,
        adapter_path=None,
        host=host,
        port=base_port,
        timeout=timeout,
    )
    adapter_eval = _evaluate_variant_suites(
        suite_configs,
        evaluate_model_variant,
        label="adapter",
        model_name=model_name,
        adapter_path=adapter_path,
        host=host,
        port=adapter_port,
        timeout=timeout,
    )

    comparison = compare_variant_results(
        base_eval["results"],
        adapter_eval["results"],
    )
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system_prompt": system_prompt if len(suite_configs) == 1 else None,
        "prompts": flatten_suite_prompts(suite_configs),
        "suites": [
            {
                "name": suite["name"],
                "system_prompt": suite["system_prompt"],
                "prompt_count": len(suite["prompts"]),
                "max_tokens": suite["max_tokens"],
            }
            for suite in suite_configs
        ],
        "base_model": base_eval,
        "adapter_model": adapter_eval,
        "comparison": comparison,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if manifest_path is not None:
        update_manifest_with_report(manifest_path, output_path, report)

    return report


def generate_openai_compatible_comparison_report(
    *,
    base_model_ref: str,
    trained_model_ref: str,
    api_key: str,
    prompts: Sequence[dict[str, str]] | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    base_url: str,
    timeout: int = 60,
    max_tokens: int = 120,
    include_decision_suite: bool = True,
    output_path: Path,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    suite_configs = build_suite_configs(
        prompts=list(prompts) if prompts is not None else None,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        include_decision_suite=include_decision_suite,
    )

    base_eval = _evaluate_variant_suites(
        suite_configs,
        evaluate_remote_model_variant,
        label="base",
        model_ref=base_model_ref,
        base_url=base_url,
        timeout=timeout,
        api_key=api_key,
    )
    adapter_eval = _evaluate_variant_suites(
        suite_configs,
        evaluate_remote_model_variant,
        label="adapter",
        model_ref=trained_model_ref,
        base_url=base_url,
        timeout=timeout,
        api_key=api_key,
    )

    comparison = compare_variant_results(
        base_eval["results"],
        adapter_eval["results"],
    )
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system_prompt": system_prompt if len(suite_configs) == 1 else None,
        "prompts": flatten_suite_prompts(suite_configs),
        "suites": [
            {
                "name": suite["name"],
                "system_prompt": suite["system_prompt"],
                "prompt_count": len(suite["prompts"]),
                "max_tokens": suite["max_tokens"],
            }
            for suite in suite_configs
        ],
        "endpoint": base_url,
        "base_model": base_eval,
        "adapter_model": adapter_eval,
        "comparison": comparison,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if manifest_path is not None:
        update_manifest_with_report(manifest_path, output_path, report)

    return report


def generate_tinker_proxy_comparison_report(
    *,
    base_model_ref: str,
    trained_model_ref: str,
    prompts: Sequence[dict[str, str]] | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    host: str = "127.0.0.1",
    base_port: int = 8096,
    adapter_port: int = 8097,
    timeout: int = 120,
    max_tokens: int = 120,
    assistant_prefix: str | None = ACTION_REASON_ASSISTANT_PREFIX,
    include_decision_suite: bool = True,
    output_path: Path,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    suite_configs = build_suite_configs(
        prompts=list(prompts) if prompts is not None else None,
        system_prompt=system_prompt,
        max_tokens=max_tokens,
        include_decision_suite=include_decision_suite,
    )
    if prompts is not None or system_prompt != DEFAULT_SYSTEM_PROMPT:
        for suite in suite_configs:
            suite["assistant_prefix"] = assistant_prefix

    base_eval = _evaluate_variant_suites(
        suite_configs,
        evaluate_tinker_proxy_variant,
        label="base",
        model_ref=base_model_ref,
        host=host,
        port=base_port,
        timeout=timeout,
    )
    adapter_eval = _evaluate_variant_suites(
        suite_configs,
        evaluate_tinker_proxy_variant,
        label="adapter",
        model_ref=trained_model_ref,
        host=host,
        port=adapter_port,
        timeout=timeout,
    )

    comparison = compare_variant_results(
        base_eval["results"],
        adapter_eval["results"],
    )
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system_prompt": system_prompt if len(suite_configs) == 1 else None,
        "prompts": flatten_suite_prompts(suite_configs),
        "suites": [
            {
                "name": suite["name"],
                "system_prompt": suite["system_prompt"],
                "prompt_count": len(suite["prompts"]),
                "max_tokens": suite["max_tokens"],
            }
            for suite in suite_configs
        ],
        "endpoint": "tinker_proxy",
        "base_model": base_eval,
        "adapter_model": adapter_eval,
        "comparison": comparison,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    if manifest_path is not None:
        update_manifest_with_report(manifest_path, output_path, report)

    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare a base MLX model against a trained adapter over HTTP."
    )
    parser.add_argument(
        "--manifest",
        help="Path to training_manifest.json with model_name and output_path",
    )
    parser.add_argument("--model", help="Base MLX model id/path")
    parser.add_argument("--adapter-path", help="Path to adapter directory")
    parser.add_argument(
        "--prompt-file",
        help="Optional JSON file with prompt objects ({id, prompt}) or strings",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--base-port", type=int, default=8094)
    parser.add_argument("--adapter-port", type=int, default=8095)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--max-tokens", type=int, default=120)
    parser.add_argument("--system-prompt", default=DEFAULT_SYSTEM_PROMPT)
    parser.add_argument(
        "--output",
        help="Where to save the comparison JSON (default: <manifest dir>/served_eval.json)",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.manifest:
        manifest_path = Path(args.manifest)
        model_name, adapter_path = load_manifest(manifest_path)
        output_path = (
            Path(args.output) if args.output else manifest_path.parent / "served_eval.json"
        )
    else:
        if not args.model or not args.adapter_path:
            parser.error("Provide either --manifest or both --model and --adapter-path")
        model_name, adapter_path = args.model, args.adapter_path
        output_path = Path(args.output) if args.output else Path.cwd() / "served_eval.json"

    prompts = load_prompts(args.prompt_file) if args.prompt_file else None
    include_decision_suite = (
        args.prompt_file is None and args.system_prompt == DEFAULT_SYSTEM_PROMPT
    )
    report = generate_comparison_report(
        model_name=model_name,
        adapter_path=adapter_path,
        prompts=prompts,
        system_prompt=args.system_prompt,
        host=args.host,
        base_port=args.base_port,
        adapter_port=args.adapter_port,
        timeout=args.timeout,
        max_tokens=args.max_tokens,
        include_decision_suite=include_decision_suite,
        output_path=output_path,
        manifest_path=manifest_path if args.manifest else None,
    )

    print(
        f"Base avg score: {report['base_model']['summary']['avg_score']:.4f} "
        f"({report['base_model']['summary']['avg_latency_ms']:.1f} ms)"
    )
    print(
        f"Adapter avg score: {report['adapter_model']['summary']['avg_score']:.4f} "
        f"({report['adapter_model']['summary']['avg_latency_ms']:.1f} ms)"
    )
    print(
        f"Distinct responses: {report['comparison']['distinct_response_count']}/"
        f"{report['base_model']['summary'].get('prompt_count', 0)}"
    )
    print(f"Saved report to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
