#!/usr/bin/env python3
"""Run eliza-1 structured-output fixtures through benchmark harness clients.

The TypeScript eliza-1 bench compares local eliza-1 decode modes against a
Cerebras reference mode. This runner keeps the same JSON report shape for the
orchestrator while routing the default should_respond task through the real
Eliza, Hermes, or OpenClaw benchmark clients.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BENCH_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "eliza-adapter"))
sys.path.insert(0, str(ROOT / "hermes-adapter"))
sys.path.insert(0, str(ROOT / "openclaw-adapter"))


SYSTEM_PROMPT = "\n".join(
    [
        "You are Eliza, an AI assistant. Your job here is to decide whether to respond to an incoming message.",
        'Output JSON of the form {"shouldRespond": "RESPOND"} (or "IGNORE" / "STOP"). No prose, no extra fields.',
        "RESPOND when the message is addressed to you, asks a question you can help with, or continues an active conversation.",
        "IGNORE when the message is between other people, is small-talk you were not addressed in, or is otherwise not yours to handle.",
        "STOP only when the user explicitly asks you to stop / terminate the interaction.",
        "In a DM channel default to RESPOND unless the user asks you to stop.",
    ]
)


def _load_fixtures(limit: int | None) -> list[dict[str, Any]]:
    fixture_path = BENCH_DIR / "src" / "fixtures" / "should-respond.json"
    data = json.loads(fixture_path.read_text(encoding="utf-8"))
    cases = [case for case in data.get("cases", []) if isinstance(case, dict)]
    if limit is not None and limit > 0:
        return cases[:limit]
    return cases


def _build_user_prompt(case: dict[str, Any]) -> str:
    channel = str(case.get("channelType") or "unspecified")
    incoming = json.dumps(str(case.get("input") or ""), ensure_ascii=False)
    return f"channel_type: {channel}\nincoming_message: {incoming}"


def _build_client(harness: str, model: str):
    provider = (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower()
    timeout_s = float(os.environ.get("ELIZA_1_HARNESS_TIMEOUT_S", "120"))
    if harness == "hermes":
        from hermes_adapter.client import HermesClient

        return HermesClient(provider=provider, model=model, timeout_s=timeout_s), None
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        return (
            OpenClawClient(
                provider=provider,
                model=model,
                timeout_s=timeout_s,
                direct_openai_compatible=True,
                reasoning_effort=os.environ.get("ELIZA_1_OPENCLAW_THINKING", "low"),
            ),
            None,
        )
    if harness == "eliza":
        from eliza_adapter import ElizaClient, ElizaServerManager

        if os.environ.get("ELIZA_BENCH_URL") and os.environ.get("ELIZA_BENCH_TOKEN"):
            return (
                ElizaClient(
                    os.environ["ELIZA_BENCH_URL"],
                    token=os.environ.get("ELIZA_BENCH_TOKEN"),
                ),
                None,
            )
        manager = ElizaServerManager()
        manager.start()
        return manager.client, manager
    raise ValueError(f"unsupported harness: {harness}")


def _send(client: Any, harness: str, model: str, case: dict[str, Any]) -> tuple[str, float, int]:
    user_prompt = _build_user_prompt(case)
    started = time.perf_counter()
    context = {
        "benchmark": "eliza_1",
        "task_id": "should_respond",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "system_prompt": SYSTEM_PROMPT,
        "temperature": 0.0,
        "max_tokens": int(os.environ.get("ELIZA_1_MAX_TOKENS", "256")),
        "response_format": {"type": "json_object"},
        "json_schema": {
            "type": "object",
            "properties": {
                "shouldRespond": {
                    "type": "string",
                    "enum": ["RESPOND", "IGNORE", "STOP"],
                }
            },
            "required": ["shouldRespond"],
            "additionalProperties": False,
        },
        "model": model,
    }
    attempts = max(1, int(os.environ.get("ELIZA_1_EMPTY_RESPONSE_ATTEMPTS", "2")))
    response = None
    for attempt in range(attempts):
        response = client.send_message(user_prompt, context=context)
        if _canonical_output(response).strip():
            break
        params = getattr(response, "params", {})
        has_structural_output = False
        if isinstance(params, dict):
            has_structural_output = any(
                key in params
                for key in ("BENCHMARK_ACTION", "BENCHMARK_ACTIONS", "tool_calls")
            )
        if getattr(response, "actions", []) or has_structural_output:
            break
        if attempt + 1 < attempts:
            time.sleep(0.25)
    if response is None:  # pragma: no cover - attempts is clamped above.
        raise RuntimeError("no response generated")
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    usage = response.params.get("usage") if isinstance(response.params, dict) else {}
    tokens = 0
    if isinstance(usage, dict):
        raw = usage.get("completion_tokens") or usage.get("completionTokens") or usage.get("output_tokens")
        if isinstance(raw, (int, float)):
            tokens = int(raw)
    text = _canonical_output(response)
    return text, elapsed_ms, tokens or max(1, len(text) // 4)


def _json_from_decision(value: object) -> str | None:
    if isinstance(value, str) and value.strip().upper() in {"RESPOND", "IGNORE", "STOP"}:
        return json.dumps({"shouldRespond": value.strip().upper()})
    return None


def _decision_from_payload(payload: object) -> str | None:
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return _json_from_decision(payload)
    if not isinstance(payload, dict):
        return None

    direct = _json_from_decision(payload.get("shouldRespond"))
    if direct is not None:
        return direct

    args = payload.get("arguments")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            args = {}
    nested = _decision_from_payload(args)
    if nested is not None:
        return nested

    function = payload.get("function")
    if isinstance(function, dict):
        nested = _decision_from_payload(function.get("arguments"))
        if nested is not None:
            return nested
    return None


def _canonical_output(response: Any) -> str:
    text = str(getattr(response, "text", "") or "")
    if _extract_json(text) is not None:
        return text

    params = getattr(response, "params", {})
    if isinstance(params, dict):
        for key in ("BENCHMARK_ACTION", "BENCHMARK_ACTIONS"):
            value = params.get(key)
            if isinstance(value, list):
                for item in value:
                    decision = _decision_from_payload(item)
                    if decision is not None:
                        return decision
            else:
                decision = _decision_from_payload(value)
                if decision is not None:
                    return decision

        tool_calls = params.get("tool_calls")
        if isinstance(tool_calls, list):
            for call in tool_calls:
                decision = _decision_from_payload(call)
                if decision is not None:
                    return decision

    actions = getattr(response, "actions", [])
    if isinstance(actions, list):
        normalized = {str(action).upper() for action in actions}
        if "STOP" in normalized:
            return json.dumps({"shouldRespond": "STOP"})
        if normalized & {"REPLY", "RESPOND", "BENCHMARK_ACTION"}:
            return json.dumps({"shouldRespond": "RESPOND"})
        if normalized & {"IGNORE", "NONE", "NO_RESPONSE"}:
            return json.dumps({"shouldRespond": "IGNORE"})

    textual = _decision_from_text(text)
    if textual is not None:
        return textual

    return text


def _decision_from_text(text: str) -> str | None:
    labels = re.findall(r"\b(RESPOND|IGNORE|STOP)\b", text.upper())
    if len(set(labels)) == 1 and labels:
        return json.dumps({"shouldRespond": labels[0]})
    for pattern in (
        r"shouldRespond['\"\s:]+(RESPOND|IGNORE|STOP)\b",
        r"output\s+json\s+(RESPOND|IGNORE|STOP)\b",
        r"so\s+(respond|ignore|stop)\b",
    ):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            return json.dumps({"shouldRespond": match.group(1).upper()})
    return None


def _extract_json(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 3:
            stripped = "\n".join(lines[1:-1]).strip()
    decoder = json.JSONDecoder()
    for index, char in enumerate(stripped):
        if char != "{":
            continue
        try:
            value, _end = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _case_metric(
    *,
    harness: str,
    case: dict[str, Any],
    index: int,
    raw_output: str,
    latency_ms: float,
    tokens: int,
    error: str | None = None,
) -> dict[str, Any]:
    parsed = _extract_json(raw_output) if error is None else None
    parse_success = parsed is not None
    schema_valid = (
        isinstance(parsed, dict)
        and parsed.get("shouldRespond") in {"RESPOND", "IGNORE", "STOP"}
    )
    label_match = (
        bool(schema_valid and parsed is not None and parsed.get("shouldRespond") == case.get("expected"))
        if parse_success
        else None
    )
    return {
        "taskId": "should_respond",
        "modeId": harness,
        "caseId": f"{case.get('id', 'case')}#{index}",
        "parse_success": parse_success,
        "schema_valid": schema_valid,
        "label_match": label_match,
        "first_token_latency_ms": None,
        "total_latency_ms": latency_ms,
        "tokens_generated": tokens,
        "tokens_per_second": (tokens / (latency_ms / 1000.0)) if latency_ms > 0 else 0.0,
        "raw_output": raw_output,
        **({"error": error} if error else {}),
    }


def _summarize(harness: str, cases: list[dict[str, Any]]) -> dict[str, Any]:
    total = max(1, len(cases))
    latencies = sorted(float(case.get("total_latency_ms") or 0.0) for case in cases)

    def rate(key: str) -> float:
        return sum(1 for case in cases if case.get(key) is True) / total

    def percentile(p: float) -> float:
        if not latencies:
            return 0.0
        index = min(len(latencies) - 1, int(round((len(latencies) - 1) * p)))
        return latencies[index]

    token_rates = [float(case.get("tokens_per_second") or 0.0) for case in cases]
    return {
        "taskId": "should_respond",
        "modeId": harness,
        "cases": len(cases),
        "parse_success_rate": rate("parse_success"),
        "schema_valid_rate": rate("schema_valid"),
        "label_match_rate": rate("label_match"),
        "first_token_latency_p50_ms": None,
        "first_token_latency_p95_ms": None,
        "total_latency_p50_ms": percentile(0.5),
        "total_latency_p95_ms": percentile(0.95),
        "mean_tokens_per_second": sum(token_rates) / len(token_rates) if token_rates else 0.0,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness", choices=["eliza", "hermes", "openclaw"], required=True)
    parser.add_argument("--model", default=os.environ.get("BENCHMARK_MODEL_NAME", "gpt-oss-120b"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)

    client, manager = _build_client(args.harness, args.model)
    cases: list[dict[str, Any]] = []
    try:
        if hasattr(client, "reset"):
            client.reset("eliza-1-should-respond", "eliza_1")
        for fixture in _load_fixtures(args.limit if args.limit > 0 else None):
            for index in range(max(1, args.n)):
                try:
                    text, latency_ms, tokens = _send(client, args.harness, args.model, fixture)
                    cases.append(
                        _case_metric(
                            harness=args.harness,
                            case=fixture,
                            index=index,
                            raw_output=text,
                            latency_ms=latency_ms,
                            tokens=tokens,
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    cases.append(
                        _case_metric(
                            harness=args.harness,
                            case=fixture,
                            index=index,
                            raw_output="",
                            latency_ms=0.0,
                            tokens=0,
                            error=f"{type(exc).__name__}: {exc}",
                        )
                    )
    finally:
        if manager is not None:
            manager.stop()

    report = {
        "schemaVersion": "eliza-1-bench-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tasks": ["should_respond"],
        "modes": [args.harness],
        "skipped": [],
        "cases": cases,
        "summaries": [_summarize(args.harness, cases)],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
