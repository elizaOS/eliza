"""action-calling CLI.

Samples planner-style records from ``training/data/final/test.jsonl`` and
scores strict-format action emission against the expected TOON output.

Output JSON shape:

```
{
  "metrics": {
    "format_ok": 0.0..1.0,
    "action_name_match": 0.0..1.0,
    "args_parse_ok": 0.0..1.0,
    "required_keys_ok": 0.0..1.0,
    "score": <geometric mean>
  }
}
```
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("action-calling")

PACKAGES_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PACKAGES_ROOT / "training"
DEFAULT_TEST = TRAINING_ROOT / "data" / "final" / "test.jsonl"
SMOKE_TEST = Path(__file__).resolve().parent / "fixtures" / "smoke.jsonl"

OPENAI_COMPAT_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "vllm": "http://127.0.0.1:8001/v1",
    "cerebras": "https://api.cerebras.ai/v1",
}

# Per the eliza_bench.py taxonomy: planner-style buckets emit `actions[N]`.
PLANNER_TYPES = {"message_handler", "agent_trace", "tool_call", "mcp_tool_call"}


def _import_helpers():
    sys.path.insert(0, str(TRAINING_ROOT / "scripts"))
    sys.path.insert(0, str(TRAINING_ROOT / "scripts" / "benchmark"))
    import toon_parser  # type: ignore[import-not-found]
    from format_for_training import format_record  # type: ignore[import-not-found]
    return toon_parser, format_record


def _expected_action(expected_doc: dict) -> dict[str, Any] | None:
    actions = expected_doc.get("actions") or []
    for entry in actions:
        if isinstance(entry, dict) and entry.get("name"):
            return entry
    return None


def _expected_required_keys(action: dict) -> list[str]:
    """Best-effort: pull arg keys present in the expected action's ``params`` block."""
    params = action.get("params")
    if not isinstance(params, dict):
        return []
    args = params.get("arguments")
    if isinstance(args, dict):
        return [k for k in args.keys() if k]
    if isinstance(params.get("tool"), str) and len(params) > 1:
        return [k for k in params.keys() if k != "tool"]
    return [k for k in params.keys() if k]


def _action_args_parse_ok(action: dict) -> bool:
    params = action.get("params")
    if not isinstance(params, dict):
        return False
    args = params.get("arguments")
    if isinstance(args, dict):
        return True
    if isinstance(args, str):
        try:
            json.loads(args)
            return True
        except json.JSONDecodeError:
            return False
    # Tool-style: ``params.tool`` plus loose key/value siblings — treat as parseable
    # if there's at least one non-tool key or no arguments expected.
    return bool(params)


def _load_planner_records(test_file: Path, limit: int) -> list[dict]:
    out: list[dict] = []
    with test_file.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            md = rec.get("metadata") or {}
            t = md.get("task_type") or ""
            if t not in PLANNER_TYPES:
                continue
            if not (rec.get("availableActions") or []):
                continue
            if not (rec.get("expectedResponse") or "").strip():
                continue
            out.append(rec)
            if len(out) >= limit:
                break
    return out


def _fallback_format_record(record: dict[str, Any]) -> dict[str, list[dict[str, str]]] | None:
    expected = str(record.get("expectedResponse") or "").strip()
    current = record.get("currentMessage") or {}
    user_text = current.get("content") if isinstance(current, dict) else None
    if not expected or not isinstance(user_text, str) or not user_text.strip():
        return None

    available_actions = record.get("availableActions") or []
    tool_specs = (record.get("metadata") or {}).get("toolSpecs") or []
    system = (
        "You are an elizaOS action planner. Respond only with the planner TOON "
        "envelope below. Do not write a title, markdown fence, JSON, or prose "
        "outside the document.\n\n"
        "Required shape:\n"
        "thought: <brief rationale>\n"
        "actions[1]:\n"
        "  - name: <ACTION_NAME>\n"
        "    params:\n"
        "      tool: <tool name when the action calls a tool>\n"
        "      arguments:\n"
        "        <required parameter>: <value>\n"
        "providers[0]:\n"
        "text: null\n"
        "simple: false"
    )
    prompt = {
        "message": user_text,
        "availableActions": available_actions,
        "toolSpecs": tool_specs,
    }
    return {
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(prompt, ensure_ascii=True)},
            {"role": "assistant", "content": expected},
        ],
    }


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="action-calling")
    p.add_argument(
        "--provider",
        default="vllm",
        choices=("vllm", "openai", "groq", "openrouter", "anthropic", "cerebras", "eliza", "mock"),
    )
    p.add_argument("--model", required=True)
    p.add_argument("--base-url", default=None)
    p.add_argument("--api-key-env", default="OPENAI_API_KEY")
    p.add_argument("--test-file", default=str(DEFAULT_TEST))
    p.add_argument("--max-examples", type=int, default=100)
    p.add_argument("--max-new-tokens", type=int, default=512)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--out", required=True)
    return p


def _make_client(args: argparse.Namespace):
    provider = args.provider.strip().lower()
    if provider == "eliza":
        from eliza_adapter import ElizaClient, ElizaServerManager  # noqa: WPS433

        manager = ElizaServerManager()
        manager.start()
        return manager.client if getattr(manager.client, "_delegate", None) is not None else ElizaClient(
            manager.client.base_url,
            token=manager.token,
        )
    if provider == "anthropic":
        from anthropic import Anthropic  # noqa: WPS433

        api_key = os.environ.get(args.api_key_env)
        if not api_key and args.api_key_env == "OPENAI_API_KEY":
            api_key = os.environ.get("ANTHROPIC_API_KEY")
        kwargs: dict[str, str] = {"api_key": api_key or "EMPTY"}
        if args.base_url:
            kwargs["base_url"] = args.base_url
        return Anthropic(**kwargs)

    from openai import OpenAI  # noqa: WPS433

    base_url = (
        args.base_url
        or os.environ.get(f"{provider.upper()}_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or OPENAI_COMPAT_BASE_URLS.get(provider)
    )
    if not base_url:
        raise SystemExit(f"--base-url required for {provider} provider")
    api_key_env = args.api_key_env
    if api_key_env == "OPENAI_API_KEY" and provider in {"groq", "openrouter", "anthropic", "cerebras"}:
        api_key_env = {
            "anthropic": "ANTHROPIC_API_KEY",
            "groq": "GROQ_API_KEY",
            "openrouter": "OPENROUTER_API_KEY",
            "cerebras": "CEREBRAS_API_KEY",
        }[provider]
    api_key = os.environ.get(api_key_env) or os.environ.get(args.api_key_env, "EMPTY")
    return OpenAI(base_url=base_url, api_key=api_key)


def _generate(
    client,
    provider: str,
    model: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
) -> str:
    if provider == "eliza":
        response = client.send_message(
            text=str(messages[-1].get("content", "")) if messages else "",
            context={
                "benchmark": "action-calling",
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            },
        )
        # Score the actual model-visible response text. Do not synthesize a
        # TOON action envelope from adapter-captured action params; that would
        # measure harness instrumentation instead of strict-format generation.
        return str(getattr(response, "text", "") or "")

    if provider == "anthropic":
        system = "\n\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "system")
        chat_messages = [
            {"role": m.get("role"), "content": str(m.get("content") or "")}
            for m in messages
            if m.get("role") in {"user", "assistant"} and m.get("content")
        ]
        resp = client.messages.create(
            model=model,
            messages=chat_messages,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system or None,
        )
        return "".join(getattr(block, "text", "") for block in resp.content)

    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return resp.choices[0].message.content or ""


def _geometric_mean(values: list[float]) -> float:
    if not values:
        return 0.0
    # Avoid log(0) by adding a small floor.
    floored = [max(v, 1e-9) for v in values]
    return math.exp(sum(math.log(v) for v in floored) / len(floored))


def main() -> int:
    args = _build_argparser().parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    toon_parser, format_record = _import_helpers()

    test_file = Path(args.test_file)
    if not test_file.exists() and test_file == DEFAULT_TEST and SMOKE_TEST.exists():
        test_file = SMOKE_TEST
    records = _load_planner_records(test_file, args.max_examples)
    if not records:
        raise SystemExit(f"no planner records found in {test_file}")
    log.info("loaded %d planner records", len(records))

    client = None if args.provider == "mock" else _make_client(args)

    n = 0
    n_format_ok = 0
    n_name_match = 0
    n_args_parse_ok = 0
    n_required_keys_ok = 0
    failures: list[dict[str, Any]] = []
    t0 = time.perf_counter()

    for i, rec in enumerate(records):
        formatted = format_record(rec)
        if not formatted:
            formatted = _fallback_format_record(rec)
        if not formatted:
            continue
        msgs = formatted["messages"]
        if msgs and msgs[-1]["role"] == "assistant":
            expected_text = msgs[-1]["content"]
            msgs = msgs[:-1]
        else:
            expected_text = ""
        if not msgs or not expected_text:
            continue

        if args.provider == "mock":
            gen = expected_text
        else:
            try:
                gen = _generate(
                    client,
                    args.provider,
                    args.model,
                    msgs,
                    args.max_new_tokens,
                    args.temperature,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("generation failed: %s", exc)
                continue
        n += 1

        pred = toon_parser.parse(gen)
        exp = toon_parser.parse(expected_text)
        format_ok = not pred.errors and "actions" in pred.document

        expected_action = _expected_action(exp.document)
        predicted_action = _expected_action(pred.document)

        name_match = bool(
            expected_action
            and predicted_action
            and predicted_action.get("name") == expected_action.get("name")
        )
        args_parse_ok = bool(predicted_action and _action_args_parse_ok(predicted_action))
        required_keys_ok = False
        if expected_action and predicted_action:
            req = set(_expected_required_keys(expected_action))
            params = predicted_action.get("params") or {}
            pred_args = params.get("arguments") if isinstance(params, dict) else None
            if isinstance(pred_args, str):
                try:
                    pred_args = json.loads(pred_args)
                except json.JSONDecodeError:
                    pred_args = None
            present_keys: set[str] = set()
            if isinstance(pred_args, dict):
                present_keys.update(pred_args.keys())
            if isinstance(params, dict):
                present_keys.update(k for k in params.keys() if k != "tool")
            required_keys_ok = req.issubset(present_keys) if req else True

        if format_ok:
            n_format_ok += 1
        if name_match:
            n_name_match += 1
        if args_parse_ok:
            n_args_parse_ok += 1
        if required_keys_ok:
            n_required_keys_ok += 1

        if not (format_ok and name_match and args_parse_ok and required_keys_ok) and len(failures) < 8:
            failures.append({
                "task_type": (rec.get("metadata") or {}).get("task_type"),
                "expected_action": expected_action,
                "predicted_action": predicted_action,
                "format_ok": format_ok,
                "name_match": name_match,
                "args_parse_ok": args_parse_ok,
                "required_keys_ok": required_keys_ok,
                "predicted": gen[:600],
            })

        if (i + 1) % 25 == 0:
            log.info("  %d/%d  fmt=%d name=%d args=%d keys=%d",
                     i + 1, len(records), n_format_ok, n_name_match,
                     n_args_parse_ok, n_required_keys_ok)

    def rate(num: int) -> float:
        return num / n if n else 0.0

    fmt = rate(n_format_ok)
    name = rate(n_name_match)
    args_ok = rate(n_args_parse_ok)
    keys = rate(n_required_keys_ok)
    score = _geometric_mean([fmt, name, args_ok, keys])
    if n == 0:
        raise SystemExit("no examples were formatted/evaluated")

    summary = {
        "model": args.model,
        "provider": args.provider,
        "generation_source": "mock_expected_text" if args.provider == "mock" else "model_text",
        "n": n,
        "elapsed_s": round(time.perf_counter() - t0, 2),
        "metrics": {
            "format_ok": fmt,
            "action_name_match": name,
            "args_parse_ok": args_ok,
            "required_keys_ok": keys,
            "score": score,
        },
        "failures": failures,
    }
    out_path = out_dir / "action-calling-results.json"
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log.info("wrote %s  score=%.3f", out_path, score)
    print(json.dumps(summary["metrics"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
