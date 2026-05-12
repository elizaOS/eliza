"""eliza-format benchmark runner.

Two execution modes:

1. **HF/local** — when ``--provider hf`` (or omitted and ``--model`` looks like
   a HF id / local path), shell out to ``training/scripts/benchmark/eliza_bench.py``
   verbatim. That script loads the model via transformers and writes
   ``<out>/summary.json``.
2. **API** — when ``--provider {vllm,openai,groq,openrouter}`` plus ``--base-url``,
   stream prompts through the OpenAI Python SDK and score with the same
   bucket scorers vendored from ``eliza_bench.py``.
3. **Mock** — when ``--provider mock``, replay expected answers from a JSONL
   fixture so orchestrator wiring can be smoke-tested without credentials.

Both modes write the same ``summary.json`` shape so the registry score
extractor (`_score_from_eliza_format_json`) doesn't care which path produced
it.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("eliza-format")

PACKAGES_ROOT = Path(__file__).resolve().parents[2]
TRAINING_ROOT = PACKAGES_ROOT / "training"
DEFAULT_TEST = TRAINING_ROOT / "data" / "final" / "test.jsonl"


def _import_bench_helpers():
    """Import scoring helpers from training/scripts/benchmark/eliza_bench.py."""
    sys.path.insert(0, str(TRAINING_ROOT / "scripts"))
    sys.path.insert(0, str(TRAINING_ROOT / "scripts" / "benchmark"))
    from benchmark import toon_parser  # type: ignore[import-not-found]

    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "eliza_bench_mod",
        TRAINING_ROOT / "scripts" / "benchmark" / "eliza_bench.py",
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load eliza_bench.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod, toon_parser


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="eliza-format benchmark")
    p.add_argument("--provider", default="hf", choices=("hf", "vllm", "openai", "groq", "openrouter", "cerebras", "mock"))
    p.add_argument("--model", required=True)
    p.add_argument("--base-url", default=None, help="OpenAI-compat base URL (vllm/openai)")
    p.add_argument("--api-key-env", default="OPENAI_API_KEY", help="Env var holding the API key")
    p.add_argument("--test-file", default=str(DEFAULT_TEST))
    p.add_argument("--max-per-bucket", type=int, default=200)
    p.add_argument("--max-new-tokens", type=int, default=512)
    p.add_argument("--temperature", type=float, default=0.0)
    p.add_argument("--out", required=True)
    return p


def _delegate_to_hf(args: argparse.Namespace) -> int:
    """Run the upstream eliza_bench.py script as a subprocess (HF path)."""
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(TRAINING_ROOT / "scripts" / "benchmark" / "eliza_bench.py"),
        "--model", args.model,
        "--test-file", args.test_file,
        "--out-dir", str(out_dir),
        "--max-per-bucket", str(args.max_per_bucket),
        "--max-new-tokens", str(args.max_new_tokens),
        "--temperature", str(args.temperature),
    ]
    log.info("delegating to: %s", " ".join(cmd))
    return subprocess.call(cmd, cwd=str(TRAINING_ROOT))


def _render_prompt_with_chat_format(rec: dict, mod) -> tuple[list[dict], str]:
    """Build (messages, expected_text) without a tokenizer (for API mode)."""
    formatted = mod.format_record(rec)
    if not formatted:
        return [], ""
    msgs = formatted["messages"]
    expected = ""
    if msgs and msgs[-1]["role"] == "assistant":
        expected = msgs[-1]["content"]
        msgs = msgs[:-1]
    return msgs, expected


def _api_call(client, model: str, messages: list[dict], max_tokens: int, temperature: float) -> str:
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    choice = response.choices[0]
    return choice.message.content or ""


def _score_text(gen_text: str, expected_text: str, bucket_name: str, rec: dict, bucket, mod, toon_parser) -> None:
    if bucket_name == "claude_distill":
        ok_fmt, ok_content, fields = mod.score_claude_distill(gen_text, expected_text)
        parse_err = False
    else:
        pred = toon_parser.parse(gen_text)
        exp = toon_parser.parse(expected_text)
        scorer = mod.SCORERS[bucket_name]
        ok_fmt, ok_content, fields = scorer(pred.document, exp.document)
        parse_err = bool(pred.errors)

    failed = None
    if not ok_content:
        failed = {
            "task_type": (rec.get("metadata") or {}).get("task_type"),
            "expected": expected_text[:600],
            "predicted": gen_text[:600],
            "fields": fields,
        }
    bucket.record(
        ok_format=ok_fmt,
        ok_content=ok_content,
        parse_err=parse_err,
        fields=fields,
        failed_example=failed,
    )


def _run_api(args: argparse.Namespace) -> int:
    mod, toon_parser = _import_bench_helpers()

    client = None
    if args.provider != "mock":
        from openai import OpenAI  # noqa: WPS433

        api_key_env = args.api_key_env
        base_url = args.base_url
        if not base_url:
            if args.provider == "openai":
                base_url = "https://api.openai.com/v1"
            elif args.provider == "groq":
                base_url = "https://api.groq.com/openai/v1"
                if api_key_env == "OPENAI_API_KEY":
                    api_key_env = "GROQ_API_KEY"
            elif args.provider == "openrouter":
                base_url = "https://openrouter.ai/api/v1"
                if api_key_env == "OPENAI_API_KEY":
                    api_key_env = "OPENROUTER_API_KEY"
            elif args.provider == "cerebras":
                base_url = "https://api.cerebras.ai/v1"
                if api_key_env == "OPENAI_API_KEY":
                    api_key_env = "CEREBRAS_API_KEY"
            else:
                raise SystemExit("--base-url is required for vllm provider")
        elif api_key_env == "OPENAI_API_KEY" and args.provider in {"groq", "openrouter", "cerebras"}:
            api_key_env = {
                "groq": "GROQ_API_KEY",
                "openrouter": "OPENROUTER_API_KEY",
                "cerebras": "CEREBRAS_API_KEY",
            }[args.provider]
        api_key = os.environ.get(api_key_env) or os.environ.get(args.api_key_env, "EMPTY")
        client = OpenAI(base_url=base_url, api_key=api_key)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    buckets = mod.load_test_records(Path(args.test_file), args.max_per_bucket)
    results: dict[str, mod.BucketResult] = {b: mod.BucketResult(name=b) for b in buckets}

    t_start = time.perf_counter()
    total_emitted = 0

    for bucket_name, recs in buckets.items():
        bucket = results[bucket_name]
        log.info("scoring bucket %s (%d records)", bucket_name, len(recs))
        for i, rec in enumerate(recs):
            messages, expected_text = _render_prompt_with_chat_format(rec, mod)
            if not messages or not expected_text:
                continue
            if args.provider == "mock":
                gen_text = expected_text
            else:
                try:
                    gen_text = _api_call(client, args.model, messages, args.max_new_tokens, args.temperature)
                except Exception as exc:  # noqa: BLE001
                    log.warning("api call failed: %s", exc)
                    continue
            total_emitted += 1

            _score_text(gen_text, expected_text, bucket_name, rec, bucket, mod, toon_parser)
            if (i + 1) % 25 == 0:
                log.info("  %s %d/%d", bucket_name, i + 1, len(recs))

    elapsed = time.perf_counter() - t_start

    bucket_dicts = {b: r.to_dict() for b, r in results.items()}
    fmt_pcts = [bd["format_pct"] / 100.0 for bd in bucket_dicts.values() if bd["n"]]
    content_pcts = [bd["content_pct"] / 100.0 for bd in bucket_dicts.values() if bd["n"]]
    fmt_avg = sum(fmt_pcts) / len(fmt_pcts) if fmt_pcts else 0.0
    content_avg = sum(content_pcts) / len(content_pcts) if content_pcts else 0.0

    summary: dict[str, Any] = {
        "model": args.model,
        "provider": args.provider,
        "test_file": str(args.test_file),
        "max_per_bucket": args.max_per_bucket,
        "elapsed_s": round(elapsed, 2),
        "examples": total_emitted,
        "buckets": bucket_dicts,
        "metrics": {
            "format_ok": fmt_avg,
            "content_ok": content_avg,
            "score": 0.5 * fmt_avg + 0.5 * content_avg,
        },
    }
    out_path = out_dir / "summary.json"
    out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log.info("wrote %s", out_path)
    print(json.dumps(summary["metrics"], indent=2))
    return 0


def main() -> int:
    args = _build_argparser().parse_args()
    if args.provider == "hf":
        return _delegate_to_hf(args)
    return _run_api(args)


if __name__ == "__main__":
    sys.exit(main())
