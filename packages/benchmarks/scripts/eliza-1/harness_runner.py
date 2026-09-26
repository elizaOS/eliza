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
import math
import os
import sys
import time
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BENCH_DIR = ROOT / "suites" / "eliza-1"
sys.path.insert(0, str(ROOT / "harnesses" / "eliza"))
sys.path.insert(0, str(ROOT / "harnesses" / "hermes"))
sys.path.insert(0, str(ROOT / "harnesses" / "openclaw"))
sys.path.insert(0, str(ROOT / "harnesses" / "codex"))


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


def _load_fixture_bundle(
    limit: int | None,
    fixture_set: str = "manual",
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    fixture_names = {
        "derived": "should-respond.derived.json",
        "manual": "should-respond.json",
    }
    fixture_path = BENCH_DIR / "src" / "fixtures" / fixture_names[fixture_set]
    data = json.loads(fixture_path.read_text(encoding="utf-8"))
    cases = [case for case in data.get("cases", []) if isinstance(case, dict)]
    if not cases:
        raise RuntimeError(f"eliza-1 fixture corpus is empty: {fixture_path}")
    ids = [str(case.get("id") or "").strip() for case in cases]
    if any(not case_id for case_id in ids) or len(set(ids)) != len(ids):
        raise RuntimeError(f"eliza-1 fixture IDs are missing or duplicated: {fixture_path}")

    derived_from = data.get("derivedFrom")
    source_count = None
    if fixture_set == "derived":
        if data.get("origin") != "dataset" or not isinstance(derived_from, str):
            raise RuntimeError("eliza-1 derived fixtures lack dataset provenance")
        # The SFT source dataset lives in the elizaOS monorepo, not in this
        # repo. The provenance cross-check runs only when the caller points
        # ELIZA1_DATASET_ROOT at a monorepo checkout.
        dataset_root = os.environ.get("ELIZA1_DATASET_ROOT")
        if dataset_root:
            source_path = Path(dataset_root) / derived_from
            if not source_path.is_file():
                raise FileNotFoundError(
                    f"eliza-1 source dataset not found: {source_path}"
                )
            source_count = sum(
                1
                for line in source_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            )
            if source_count != len(cases):
                raise RuntimeError(
                    "eliza-1 derived fixture count does not match its source split: "
                    f"fixtures={len(cases)}, source={source_count}"
                )

    provenance = {
        "fixture_set": fixture_set,
        "fixture_path": str(fixture_path.relative_to(ROOT)),
        "origin": data.get("origin"),
        "derived_from": derived_from,
        "source_count": source_count,
        "full_case_count": len(cases),
    }
    label_counts = {label: sum(case.get("expected") == label for case in cases)
                    for label in ("RESPOND", "IGNORE", "STOP")}
    provenance["label_counts"] = label_counts
    provenance["majority_label_baseline"] = max(label_counts.values()) / len(cases)
    provenance["decision_class_coverage"] = sum(count > 0 for count in label_counts.values())
    provenance["evaluation_scope"] = (
        "three-class decision" if all(label_counts.values()) else "single-class regression"
    )
    if limit is not None and limit > 0:
        cases = cases[:limit]
    return cases, provenance


def _load_fixtures(
    limit: int | None,
    fixture_set: str = "manual",
) -> list[dict[str, Any]]:
    cases, _provenance = _load_fixture_bundle(limit, fixture_set)
    return cases


def _build_user_prompt(case: dict[str, Any]) -> str:
    channel = str(case.get("channelType") or "unspecified")
    incoming = json.dumps(str(case.get("input") or ""), ensure_ascii=False)
    return f"channel_type: {channel}\nincoming_message: {incoming}"


def _build_codex_client(model: str, args: argparse.Namespace):
    from codex_adapter.accounts import CodexAccount
    from codex_adapter.client import CodexClient

    if os.environ.get("BENCHMARK_MODEL_PROVIDER") != "codex-native":
        raise ValueError("Codex requires provider codex-native: its configured CLI provider is not an API-provider comparison")
    output = Path(args.out).resolve().parent / "codex"
    workspace_root = output / "workspaces"
    workspace_root.mkdir(parents=True, exist_ok=True)

    class DecisionClient(CodexClient):
        def reset(self, task_id: str, benchmark: str, **kwargs: object):
            self.cwd = Path(tempfile.mkdtemp(prefix="task-", dir=workspace_root))
            return super().reset(task_id, benchmark, **kwargs)

    accounts = [CodexAccount("explicit-cli-home", Path(args.codex_home).expanduser().resolve())] if args.codex_home else None
    client = DecisionClient(model=model, accounts=accounts,
                            accounts_spec=args.accounts, timeout_s=args.timeout_s,
                            reasoning_effort=args.reasoning_effort,
                            receipt_dir=output / "attempts", sandbox="read-only")
    if not client.is_ready():
        raise RuntimeError(f"Codex is unavailable: {client.health()}")
    return client, None


def _ready_native_client(client: Any):
    health = client.health()
    if health.get("status") != "ready" or health.get("publishable_native") is not True:
        raise RuntimeError(f"Native decision harness unavailable: {health}")
    return client, None


def _build_client(harness: str, model: str):
    provider = (os.environ.get("BENCHMARK_MODEL_PROVIDER") or "cerebras").strip().lower()
    timeout_s = float(os.environ.get("ELIZA_1_HARNESS_TIMEOUT_S", "120"))
    if harness == "hermes":
        from hermes_adapter.client import HermesClient

        return _ready_native_client(HermesClient(provider=provider, model=model, timeout_s=timeout_s))
    if harness == "openclaw":
        from openclaw_adapter.client import OpenClawClient

        return _ready_native_client(
            OpenClawClient(
                provider=provider,
                model=model,
                timeout_s=timeout_s,
                reasoning_effort=os.environ.get("ELIZA_1_OPENCLAW_THINKING", "low"),
            ),
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


def _send(
    client: Any,
    harness: str,
    model: str,
    case: dict[str, Any],
    task_id: str,
    receipts: list[dict[str, Any]] | None = None,
) -> tuple[str, float, int | None]:
    user_prompt = _build_user_prompt(case)
    started = time.perf_counter()
    context = {
        "benchmark": "eliza_1",
        "task_id": task_id,
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
    attempts = max(1, int(os.environ.get("ELIZA_1_EMPTY_RESPONSE_ATTEMPTS", "1")))
    response = None
    total_tokens = 0
    all_usage_observed = True
    for attempt in range(attempts):
        receipt: dict[str, Any] = {"task_id": task_id, "context": context, "message": user_prompt}
        if receipts is not None:
            receipts.append(receipt)
        try:
            response = client.send_message(user_prompt, context=context)
        except Exception as exc:
            # error-policy:J1 retain the failed attempt before the case boundary handles it.
            receipt["error"] = f"{type(exc).__name__}: {exc}"
            raise
        receipt["response"] = {"text": response.text, "actions": response.actions, "params": response.params}
        usage = response.params.get("usage") if isinstance(response.params, dict) else {}
        observed_tokens = None
        if isinstance(usage, dict):
            for key in ("completion_tokens", "completionTokens", "output_tokens"):
                raw = usage.get(key)
                if isinstance(raw, int) and not isinstance(raw, bool) and raw >= 0:
                    observed_tokens = raw
                    break
        if observed_tokens is None:
            all_usage_observed = False
        else:
            total_tokens += observed_tokens
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
    tokens = total_tokens if all_usage_observed else None
    text = _canonical_output(response)
    return text, elapsed_ms, tokens



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
        return json.dumps(payload)

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

    return text


def _extract_json(text: str) -> dict[str, Any] | None:
    stripped = text.strip()
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None



def _case_metric(
    *,
    harness: str,
    case: dict[str, Any],
    index: int,
    raw_output: str,
    latency_ms: float,
    tokens: int | None,
    error: str | None = None,
) -> dict[str, Any]:
    parsed = _extract_json(raw_output) if error is None else None
    parse_success = parsed is not None
    schema_valid = (
        isinstance(parsed, dict)
        and set(parsed) == {"shouldRespond"}
        and isinstance(parsed.get("shouldRespond"), str)
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
        "expected_label": case.get("expected"),
        "parse_success": parse_success,
        "schema_valid": schema_valid,
        "label_match": label_match,
        "first_token_latency_ms": None,
        "total_latency_ms": latency_ms,
        "tokens_generated": tokens,
        "tokens_per_second": (tokens / (latency_ms / 1000.0))
        if tokens is not None and latency_ms > 0 else None,
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

    token_rates = [float(case["tokens_per_second"]) for case in cases
                   if case.get("tokens_per_second") is not None]
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
        "mean_tokens_per_second": sum(token_rates) / len(token_rates) if token_rates else None,
        "token_usage_observed_cases": sum(case.get("tokens_generated") is not None for case in cases),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness", choices=["eliza", "hermes", "openclaw", "codex"], required=True)
    parser.add_argument("--model", default=os.environ.get("BENCHMARK_MODEL_NAME", "gemma-4-31b"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--codex-home", help="Explicit authenticated CLI home; otherwise use materialized Eliza accounts")
    parser.add_argument("--accounts")
    parser.add_argument("--reasoning-effort", default=os.environ.get("BENCHMARK_REASONING_EFFORT"))
    parser.add_argument("--timeout-s", type=float, default=180)

    parser.add_argument("--n", type=int, default=1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument(
        "--fixture-set",
        choices=["derived", "manual"],
        default="manual",
        help="Fixture corpus (default: manual decision set covering RESPOND, IGNORE and STOP; derived is RESPOND-only regression)",
    )
    args = parser.parse_args(argv)

    if args.codex_home and args.accounts:
        parser.error("--codex-home and --accounts are mutually exclusive")
    if not math.isfinite(args.timeout_s) or args.timeout_s <= 0:
        parser.error("--timeout-s must be positive")
    client, manager = (_build_codex_client(args.model, args) if args.harness == "codex"
                       else _build_client(args.harness, args.model))
    fixtures, corpus = _load_fixture_bundle(
        args.limit if args.limit > 0 else None,
        args.fixture_set,
    )
    cases: list[dict[str, Any]] = []
    try:
        for fixture in fixtures:
            for index in range(max(1, args.n)):
                case_id = str(fixture.get("id") or "case")
                task_id = f"eliza-1-should-respond-{case_id}-{index}"
                case_attempts: list[dict[str, Any]] = []
                try:
                    if hasattr(client, "reset"):
                        client.reset(task_id, "eliza_1")
                    text, latency_ms, tokens = _send(
                        client,
                        args.harness,
                        args.model,
                        fixture,
                        task_id,
                        receipts=case_attempts,
                    )
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
                # error-policy:J1 Preserve every attempted cell in the report,
                # then make the process fail after the artifact is written.
                except Exception as exc:  # noqa: BLE001
                    cases.append(
                        _case_metric(
                            harness=args.harness,
                            case=fixture,
                            index=index,
                            raw_output="",
                            latency_ms=0.0,
                            tokens=None,
                            error=f"{type(exc).__name__}: {exc}",
                        )
                    )
                if args.harness in {"hermes", "openclaw"}:
                    cases[-1]["native_attempts"] = case_attempts
    finally:
        if manager is not None:
            manager.stop()

    report = {
        "schemaVersion": "eliza-1-bench-v1",
        "execution": {"harness": args.harness, "model_requested": args.model,
                      "provider_label": os.environ.get("BENCHMARK_MODEL_PROVIDER"),
                      "provider_observed": None,
                      "max_attempts_per_case": max(1, int(os.environ.get("ELIZA_1_EMPTY_RESPONSE_ATTEMPTS", "1"))),
                      "native_receipts": "codex/attempts" if args.harness == "codex" else None},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tasks": ["should_respond"],
        "modes": [args.harness],
        "corpus": {
            **corpus,
            "selected_case_count": len(fixtures),
            "selected_case_ids": [str(case["id"]) for case in fixtures],
            "repetitions": max(1, args.n),
            "expected_result_count": len(fixtures) * max(1, args.n),
        },
        "skipped": [],
        "cases": cases,
        "summaries": [_summarize(args.harness, cases)],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(str(out))
    return 1 if any("error" in case for case in cases) else 0


if __name__ == "__main__":
    raise SystemExit(main())
