"""End-to-end benchmark for elizaOS-trained Qwen models.

Runs the model against held-out test records and scores two dimensions:

  format_ok   : did the model emit a parsable TOON document with the
                required fields for that task type?
  content_ok  : did the model match the expected response on the
                semantically important fields (e.g. action name, RESPOND
                vs IGNORE, action list match)?

Three task buckets are tracked:

  should_respond — RESPOND/IGNORE/STOP routing decision
  message_handler — planner output: thought + actions[] + providers + text
  action_call    — single-action planner output where the expected response
                   names a specific action and we score the name match

Usage
-----

    uv run --extra train python scripts/benchmark/eliza_bench.py \
        --model Qwen/Qwen3.5-2B \
        --test-file data/final/test.jsonl \
        --max-per-bucket 200 \
        --out-dir benchmarks/qwen35-2b-base

    # After fine-tuning, point at the merged checkpoint:
    uv run --extra train python scripts/benchmark/eliza_bench.py \
        --model checkpoints/qwen35-2b-apollo-v1/final \
        --base-model Qwen/Qwen3.5-2B \
        --test-file data/final/test.jsonl \
        --out-dir benchmarks/qwen35-2b-apollo-v1
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import re  # noqa: E402

from format_for_training import format_record  # noqa: E402
from benchmark.toon_parser import parse as parse_toon  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bench")


SHOULD_RESPOND_TYPES = {"should_respond", "should_respond_with_context",
                        "dialogue_routing", "context_routing"}
PLANNER_TYPES = {"message_handler", "tool_call", "agent_trace",
                 "action_planner", "planner"}
REPLY_TYPES = {"reply", "response"}
# Claude-distilled reasoning records — assistant content is
# `<think>...</think>final` (verbatim, no TOON re-encoding). Scored by a
# distinct path that checks the think-tag envelope rather than TOON fields.
CLAUDE_DISTILL_TYPES = {"claude_distill"}


@dataclass
class BucketResult:
    name: str
    n: int = 0
    format_ok: int = 0
    content_ok: int = 0
    parse_errors: int = 0
    expected_field_present: int = 0
    field_match: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    field_total: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    examples_failed: list[dict[str, Any]] = field(default_factory=list)
    # Throughput accounting — wallclock seconds spent inside model.generate()
    # for this bucket, plus the prompt / generated token counts seen.
    gen_seconds: float = 0.0
    prompt_tokens: int = 0
    gen_tokens: int = 0

    def record(self, *, ok_format: bool, ok_content: bool,
               parse_err: bool, fields: dict[str, bool],
               failed_example: dict | None,
               gen_dt: float = 0.0, n_prompt_tokens: int = 0,
               n_gen_tokens: int = 0) -> None:
        self.n += 1
        if ok_format:
            self.format_ok += 1
        if ok_content:
            self.content_ok += 1
        if parse_err:
            self.parse_errors += 1
        self.gen_seconds += gen_dt
        self.prompt_tokens += n_prompt_tokens
        self.gen_tokens += n_gen_tokens
        for k, ok in fields.items():
            self.field_total[k] += 1
            if ok:
                self.field_match[k] += 1
        if failed_example and len(self.examples_failed) < 8:
            self.examples_failed.append(failed_example)

    def to_dict(self) -> dict:
        def pct(num: int, denom: int) -> float:
            return round(100.0 * num / denom, 2) if denom else 0.0
        def rate(num: int, denom: float) -> float:
            return round(num / denom, 2) if denom > 0 else 0.0
        return {
            "bucket": self.name,
            "n": self.n,
            "format_ok": self.format_ok,
            "format_pct": pct(self.format_ok, self.n),
            "content_ok": self.content_ok,
            "content_pct": pct(self.content_ok, self.n),
            "parse_errors": self.parse_errors,
            # prompt_tps / gen_tps share the same denominator (the wallclock
            # spent inside model.generate(): prefill + decode); model.generate
            # does not separate the two phases, so these are throughput proxies,
            # not isolated prefill / decode rates.
            "prompt_tps": rate(self.prompt_tokens, self.gen_seconds),
            "gen_tps": rate(self.gen_tokens, self.gen_seconds),
            "gen_seconds": round(self.gen_seconds, 2),
            "field_match_pct": {
                k: pct(self.field_match[k], v)
                for k, v in self.field_total.items()
            },
            "examples_failed": self.examples_failed,
        }


def classify(record: dict) -> str | None:
    md = record.get("metadata") or {}
    t = md.get("task_type") or ""
    if t in SHOULD_RESPOND_TYPES:
        return "should_respond"
    if t in PLANNER_TYPES:
        return "message_handler"
    if t in REPLY_TYPES:
        return "reply"
    if t in CLAUDE_DISTILL_TYPES:
        return "claude_distill"
    return None


def _message_handler_doc(doc: dict) -> dict | None:
    candidate = doc.get("messageHandler")
    if isinstance(candidate, dict):
        return candidate
    if doc.get("action") in ("RESPOND", "IGNORE", "STOP"):
        return doc
    return None


def score_should_respond(predicted: dict, expected: dict) -> tuple[bool, bool, dict[str, bool]]:
    pred_handler = _message_handler_doc(predicted)
    exp_handler = _message_handler_doc(expected)
    if pred_handler is not None or exp_handler is not None:
        pred_action = str((pred_handler or {}).get("action", "")).upper()
        exp_action = str((exp_handler or {}).get("action", "")).upper()
        pred_contexts = (pred_handler or {}).get("contexts")
        exp_contexts = (exp_handler or {}).get("contexts")
        fields = {
            "action": pred_action == exp_action,
            "contexts": isinstance(pred_contexts, list)
                        and isinstance(exp_contexts, list)
                        and pred_contexts == exp_contexts,
            "thought_present": bool((pred_handler or {}).get("thought")),
        }
        fmt = pred_action in ("RESPOND", "IGNORE", "STOP") and isinstance(pred_contexts, list)
        return fmt, fields["action"], fields

    required = ("name", "action", "reasoning", "primaryContext")
    fmt = all(k in predicted for k in required) and \
        str(predicted.get("action", "")).upper() in ("RESPOND", "IGNORE", "STOP")
    fields = {
        "action": str(predicted.get("action", "")).upper() ==
                  str(expected.get("action", "")).upper(),
        "name": predicted.get("name") == expected.get("name"),
        "primaryContext": predicted.get("primaryContext") == expected.get("primaryContext"),
    }
    content = fields["action"]
    return fmt, content, fields


def score_message_handler(predicted: dict, expected: dict) -> tuple[bool, bool, dict[str, bool]]:
    required = ("thought", "actions", "text")
    fmt = all(k in predicted for k in required)
    pred_actions = predicted.get("actions") or []
    exp_actions = expected.get("actions") or []
    pred_names = [a.get("name") for a in pred_actions if isinstance(a, dict)]
    exp_names = [a.get("name") for a in exp_actions if isinstance(a, dict)]
    fields = {
        "action_count": len(pred_names) == len(exp_names),
        "action_names": pred_names == exp_names,
        "first_action_name": (pred_names[:1] == exp_names[:1]) if exp_names else
                              (len(pred_names) == 0),
        "providers_present": "providers" in predicted,
    }
    content = fields["action_names"] and fields["action_count"]
    return fmt, content, fields


def score_reply(predicted: dict, expected: dict) -> tuple[bool, bool, dict[str, bool]]:
    fmt = "thought" in predicted and "text" in predicted
    pred_text = (predicted.get("text") or "").strip()
    exp_text = (expected.get("text") or "").strip()
    fields = {
        "text_present": bool(pred_text),
        "text_nonempty_match": bool(pred_text) and bool(exp_text),
    }
    # Reply quality is hard to score without an LLM judge — we score format
    # and presence here. A separate LLM-judge pass can grade content.
    content = fields["text_present"]
    return fmt, content, fields


_THINK_RE = re.compile(r"<think>([\s\S]*?)</think>\s*([\s\S]*)", re.IGNORECASE)


def score_claude_distill(predicted_raw: str, expected_raw: str) -> tuple[bool, bool, dict[str, bool]]:
    """Score the `<think>...</think>final` envelope used by Claude distill records.

    These records do NOT round-trip through the TOON parser — the content is
    raw text. Format check: the prediction starts with a `<think>...</think>`
    block followed by a non-empty body. Content check: presence of any
    final answer at all (we cannot LLM-judge correctness here).
    """
    pred_match = _THINK_RE.match((predicted_raw or "").lstrip())
    exp_match = _THINK_RE.match((expected_raw or "").lstrip())

    fields = {
        "has_think_open": "<think>" in (predicted_raw or "").lower(),
        "has_think_close": "</think>" in (predicted_raw or "").lower(),
        "starts_with_think": (predicted_raw or "").lstrip().lower().startswith("<think>"),
        "has_final_answer": bool(pred_match and pred_match.group(2).strip()),
        "expected_had_think": bool(exp_match),
    }
    fmt = fields["starts_with_think"] and fields["has_think_close"]
    content = fmt and fields["has_final_answer"]
    return fmt, content, fields


SCORERS = {
    "should_respond": score_should_respond,
    "message_handler": score_message_handler,
    "reply": score_reply,
    # claude_distill scorer signature is different (raw strings, not TOON
    # documents) — the main loop branches on bucket name.
}


def load_test_records(path: Path, max_per_bucket: int) -> dict[str, list[dict]]:
    buckets: dict[str, list[dict]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            bucket = classify(rec)
            if bucket is None:
                continue
            if len(buckets[bucket]) >= max_per_bucket:
                # All buckets full?
                if all(len(buckets[b]) >= max_per_bucket for b in
                       ("should_respond", "message_handler", "reply",
                        "claude_distill")):
                    break
                continue
            buckets[bucket].append(rec)
    return buckets


def render_messages(record: dict, tokenizer) -> tuple[str, str]:
    """Returns (rendered_prompt, expected_assistant_text)."""
    formatted = format_record(record)
    if not formatted:
        return "", ""
    msgs = formatted["messages"]
    expected = ""
    if msgs and msgs[-1]["role"] == "assistant":
        expected = msgs[-1]["content"]
        msgs = msgs[:-1]
    text = tokenizer.apply_chat_template(
        msgs, tokenize=False, add_generation_prompt=True,
    )
    return text, expected


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True,
                    help="HF id or local path. Adapter dirs OK with --base-model.")
    ap.add_argument("--base-model", default=None,
                    help="If --model is a LoRA adapter, this is the base.")
    ap.add_argument("--test-file", default=str(ROOT / "data" / "final" / "test.jsonl"))
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--max-per-bucket", type=int, default=200)
    ap.add_argument("--max-new-tokens", type=int, default=512,
                    help="Per-call generation cap. The full registry "
                         "infer_max_out is too long for benchmark sanity; "
                         "use serve_local.py for true long-context tests.")
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--dtype", default="bf16", choices=("bf16", "fp16", "fp32"))
    ap.add_argument("--quantized", default=None,
                    help="Path to a quantized model file (gguf etc.) — uses llama.cpp/vllm runner.")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    log.info("loading model %s (base=%s)", args.model, args.base_model)
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16,
             "fp32": torch.float32}[args.dtype]

    tokenizer_src = args.base_model or args.model
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_src, trust_remote_code=True)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"

    if args.base_model:
        from peft import PeftModel
        base = AutoModelForCausalLM.from_pretrained(
            args.base_model, torch_dtype=dtype, trust_remote_code=True,
            device_map="auto" if args.device == "cuda" else None,
        )
        model = PeftModel.from_pretrained(base, args.model)
    else:
        model = AutoModelForCausalLM.from_pretrained(
            args.model, torch_dtype=dtype, trust_remote_code=True,
            device_map="auto" if args.device == "cuda" else None,
        )
    model.eval()

    # For hybrid linear+full-attention models (Qwen3.5 / Qwen3.6) we MUST
    # pre-build a layer-type-aware cache or HF will create a DynamicCache
    # whose internal layer-type dispatch is correct, but if the underlying
    # model implementation accidentally creates a plain DynamicCache without
    # a config, has_previous_state(layer_idx=0) raises. The bench previously
    # relied on the model.generate() default (which builds DynamicCache(config)
    # correctly inside the modeling forward), but constructing the cache
    # explicitly here makes the code path uniform across hybrid and dense
    # models and lets us swap backends from the CLI later.
    from inference.hybrid_cache import has_hybrid_layer_types, make_hybrid_cache
    bench_is_hybrid = has_hybrid_layer_types(model)
    if bench_is_hybrid:
        log.info("hybrid Qwen3.5/3.6 detected — bench will rebuild a "
                 "ElizaHybridCache(bf16) per generation call")

    log.info("loading test records (max %d per bucket)", args.max_per_bucket)
    buckets = load_test_records(Path(args.test_file), args.max_per_bucket)
    for b, recs in buckets.items():
        log.info("  bucket %s: %d records", b, len(recs))

    results: dict[str, BucketResult] = {b: BucketResult(name=b) for b in buckets}
    t_start = time.perf_counter()
    total_emitted = 0
    total_prompt_tokens = 0
    total_gen_tokens = 0

    for bucket_name, recs in buckets.items():
        bucket = results[bucket_name]
        log.info("scoring bucket %s", bucket_name)
        for i, rec in enumerate(recs):
            prompt, expected_text = render_messages(rec, tokenizer)
            if not prompt or not expected_text:
                continue

            inputs = tokenizer(prompt, return_tensors="pt", truncation=True,
                               max_length=8192).to(model.device)
            gen_kwargs = dict(
                max_new_tokens=args.max_new_tokens,
                do_sample=args.temperature > 0,
                temperature=max(args.temperature, 1e-5),
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )
            if bench_is_hybrid:
                gen_kwargs["past_key_values"] = make_hybrid_cache(
                    model, full_attn_backend="bf16",
                )
            with torch.inference_mode():
                t0 = time.perf_counter()
                out = model.generate(**inputs, **gen_kwargs)
                dt = time.perf_counter() - t0
            prompt_len = inputs["input_ids"].shape[1]
            gen = out[0, prompt_len:]
            gen_text = tokenizer.decode(gen, skip_special_tokens=True)
            total_emitted += 1
            total_prompt_tokens += prompt_len
            total_gen_tokens += int(gen.shape[0])

            if bucket_name == "claude_distill":
                ok_fmt, ok_content, fields = score_claude_distill(gen_text, expected_text)
                parse_err = False
            else:
                pred = parse_toon(gen_text)
                exp = parse_toon(expected_text)
                scorer = SCORERS[bucket_name]
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
                ok_format=ok_fmt, ok_content=ok_content,
                parse_err=parse_err,
                fields=fields, failed_example=failed,
                gen_dt=dt, n_prompt_tokens=int(prompt_len),
                n_gen_tokens=int(gen.shape[0]),
            )

            if (i + 1) % 25 == 0:
                log.info("  %s %d/%d  fmt=%.1f%%  content=%.1f%%  last=%.2fs",
                         bucket_name, i + 1, len(recs),
                         100 * bucket.format_ok / max(bucket.n, 1),
                         100 * bucket.content_ok / max(bucket.n, 1),
                         dt)

    elapsed = time.perf_counter() - t_start
    total_gen_seconds = sum(r.gen_seconds for r in results.values())
    summary = {
        "model": args.model,
        "base_model": args.base_model,
        "test_file": str(args.test_file),
        "max_per_bucket": args.max_per_bucket,
        "elapsed_s": round(elapsed, 2),
        "examples": total_emitted,
        # tokens_per_sec_gen is over the full wallclock (includes scoring
        # overhead); prompt_tps / gen_tps are over the generate()-only
        # wallclock (prefill+decode, not separated by model.generate).
        "tokens_per_sec_gen": round(total_gen_tokens / max(elapsed, 1e-6), 2),
        "prompt_tps": round(total_prompt_tokens / max(total_gen_seconds, 1e-6), 2),
        "gen_tps": round(total_gen_tokens / max(total_gen_seconds, 1e-6), 2),
        "gen_seconds": round(total_gen_seconds, 2),
        "avg_gen_len": round(total_gen_tokens / max(total_emitted, 1), 1),
        "avg_prompt_len": round(total_prompt_tokens / max(total_emitted, 1), 1),
        "buckets": {b: r.to_dict() for b, r in results.items()},
    }
    out_dir.joinpath("summary.json").write_text(json.dumps(summary, indent=2))
    log.info("wrote %s", out_dir / "summary.json")
    print(json.dumps({"buckets": summary["buckets"],
                       "tokens_per_sec_gen": summary["tokens_per_sec_gen"],
                       "prompt_tps": summary["prompt_tps"],
                       "gen_tps": summary["gen_tps"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
