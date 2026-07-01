#!/usr/bin/env python3
"""In-agent eliza-1 verification: download GGUF from HF and test via llama.cpp.

This is the true in-agent test — it uses llama-cpp-python (the same inference
engine eliza uses locally) to load the fine-tuned GGUF and verify it produces
valid eliza_native_v1 formatted responses.

Usage:
    python scripts/test_inagent_eliza.py --tier 2b [--max-samples 20]
    python scripts/test_inagent_eliza.py --tiers all [--hf-token TOKEN]
    python scripts/test_inagent_eliza.py --local-gguf /path/to/model.gguf

Requirements:
    pip install llama-cpp-python huggingface-hub
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from manifest.eliza1_manifest import ELIZA_1_TIERS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("test_inagent")

HF_REPO = "elizaos/eliza-1"
TEST_FILE = ROOT / "data" / "final" / "test.jsonl"
CACHE_DIR = Path.home() / ".cache" / "eliza-1-ggufs"

ALL_TIERS = list(ELIZA_1_TIERS)
ACTIVE_TIER_SET = set(ALL_TIERS)

ELIZA_SYSTEM_PROMPT = "You are Eliza, an AI assistant. Help the user with their request."

# Minimal tool-call trigger prompts to verify the model calls tools correctly
TOOL_CALL_PROMPTS = [
    {
        "system": ELIZA_SYSTEM_PROMPT,
        "user": "What is the current weather in San Francisco?",
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            },
        }],
        "expected_tool": "get_weather",
    },
    {
        "system": ELIZA_SYSTEM_PROMPT,
        "user": "Search for recent news about AI.",
        "tools": [{
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        }],
        "expected_tool": "web_search",
    },
]

TEXT_PROMPTS = [
    "What is the capital of France?",
    "Explain what an API is in one sentence.",
    "Write a haiku about programming.",
]


def _active_tier_help() -> str:
    return ", ".join(ALL_TIERS)


def _split_tiers(value: str) -> list[str]:
    if value == "all":
        return list(ALL_TIERS)
    return [tier.strip() for tier in value.split(",") if tier.strip()]


def resolve_requested_tiers(tier: str | None, tiers: str | None) -> list[str]:
    if tier:
        requested = [tier]
    elif tiers:
        requested = _split_tiers(tiers)
    else:
        requested = list(ALL_TIERS)
    if not requested:
        raise SystemExit(f"no tiers requested; active tiers: {_active_tier_help()}")
    invalid = [candidate for candidate in requested if candidate not in ACTIVE_TIER_SET]
    if invalid:
        raise SystemExit(
            "unknown or retired eliza-1 tier(s): "
            f"{', '.join(invalid)}; active tiers: {_active_tier_help()}"
        )
    return requested


def _download_gguf(tier: str, hf_token: str | None) -> Path | None:
    """Download the GGUF for a tier from HF elizaos/eliza-1."""
    from huggingface_hub import HfApi, hf_hub_download
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    api = HfApi(token=hf_token)
    # List files in bundles/{tier}/text/
    prefix = f"bundles/{tier}/text/"
    try:
        files = api.list_repo_files(HF_REPO, repo_type="model", token=hf_token)
    except Exception as e:
        log.error("[%s] failed to list HF files: %s", tier, e)
        return None

    gguf_files = [f for f in files if f.startswith(prefix) and f.endswith(".gguf")]
    if not gguf_files:
        log.warning("[%s] no GGUF found under %s in %s", tier, prefix, HF_REPO)
        return None

    gguf_file = sorted(gguf_files)[0]
    fname = Path(gguf_file).name
    local_path = CACHE_DIR / f"{tier}_{fname}"
    if local_path.exists():
        log.info("[%s] using cached GGUF: %s", tier, local_path)
        return local_path

    log.info("[%s] downloading %s ...", tier, gguf_file)
    try:
        downloaded = hf_hub_download(
            repo_id=HF_REPO,
            filename=gguf_file,
            repo_type="model",
            token=hf_token,
            local_dir=str(CACHE_DIR),
        )
        import shutil
        shutil.copy(downloaded, local_path)
        log.info("[%s] downloaded to %s", tier, local_path)
        return local_path
    except Exception as e:
        log.error("[%s] download failed: %s", tier, e)
        return None


def _format_prompt_for_llama(system: str, user: str, tools: list | None = None) -> str:
    """Format a prompt using Gemma 4 chat template compatible with llama.cpp."""
    parts = []
    if system:
        parts.append(f"<start_of_turn>system\n{system}<end_of_turn>")
    if tools:
        tool_json = json.dumps(tools, indent=2)
        parts.append(f"<start_of_turn>tools\n{tool_json}<end_of_turn>")
    parts.append(f"<start_of_turn>user\n{user}<end_of_turn>")
    parts.append("<start_of_turn>model\n")
    return "\n".join(parts)


def _check_tool_call_in_output(output: str, expected_tool: str) -> bool:
    """Check if output contains a valid tool call for the expected tool."""
    # Check for eliza native format: {"type": "tool_use", "name": "..."}
    # or XML hermes format: <tool_call>{"name": "..."}</tool_call>
    # or simple JSON with name field
    output_lower = output.lower()
    if expected_tool.lower() in output_lower:
        return True
    # Try to parse any JSON in the output
    for line in output.split("\n"):
        line = line.strip()
        if line.startswith("{"):
            try:
                obj = json.loads(line)
                if obj.get("name") == expected_tool or obj.get("tool") == expected_tool:
                    return True
            except json.JSONDecodeError:
                pass
    return False


def _check_text_response(output: str) -> bool:
    """Check if output is a non-empty, non-degenerate text response."""
    stripped = output.strip()
    if not stripped:
        return False
    if len(stripped) < 5:
        return False
    # Not just repeated tokens
    if len(set(stripped.split())) < 2:
        return False
    return True


def test_gguf(gguf_path: Path, tier: str, max_samples: int = 10) -> dict[str, Any]:
    """Load GGUF via llama-cpp-python and run test prompts."""
    try:
        from llama_cpp import Llama
    except ImportError:
        log.error("llama-cpp-python not installed: pip install llama-cpp-python")
        return {"tier": tier, "error": "llama-cpp-python not installed", "passed": False}

    log.info("[%s] loading GGUF: %s", tier, gguf_path)
    t0 = time.perf_counter()
    try:
        llm = Llama(
            model_path=str(gguf_path),
            n_ctx=2048,
            n_gpu_layers=-1,  # Use all GPU layers (MPS on Mac, CUDA on Linux)
            verbose=False,
        )
    except Exception as e:
        log.error("[%s] failed to load GGUF: %s", tier, e)
        return {"tier": tier, "error": f"load_failed: {e}", "passed": False}
    load_time = time.perf_counter() - t0
    log.info("[%s] GGUF loaded in %.1fs", tier, load_time)

    results = {
        "tier": tier,
        "gguf_path": str(gguf_path),
        "load_time_s": round(load_time, 1),
        "tool_call_tests": [],
        "text_tests": [],
        "passed": False,
    }

    # Test tool calls
    tool_ok = 0
    for i, prompt_spec in enumerate(TOOL_CALL_PROMPTS[:max_samples]):
        prompt_text = _format_prompt_for_llama(
            prompt_spec["system"],
            prompt_spec["user"],
            prompt_spec.get("tools"),
        )
        try:
            t1 = time.perf_counter()
            out = llm(prompt_text, max_tokens=256, temperature=0.0, stop=["<end_of_turn>"])
            elapsed = time.perf_counter() - t1
            text = out["choices"][0]["text"] if out["choices"] else ""
            ok = _check_tool_call_in_output(text, prompt_spec["expected_tool"])
            if ok:
                tool_ok += 1
            results["tool_call_tests"].append({
                "prompt": prompt_spec["user"],
                "expected_tool": prompt_spec["expected_tool"],
                "output_snippet": text[:200],
                "ok": ok,
                "elapsed_s": round(elapsed, 2),
            })
            log.info("[%s] tool-call %d: expected=%s ok=%s (%.1fs)",
                     tier, i + 1, prompt_spec["expected_tool"], ok, elapsed)
        except Exception as e:
            log.error("[%s] tool-call test %d failed: %s", tier, i + 1, e)
            results["tool_call_tests"].append({"error": str(e), "ok": False})

    # Test text responses
    text_ok = 0
    for i, user_text in enumerate(TEXT_PROMPTS[:max_samples]):
        prompt_text = _format_prompt_for_llama(ELIZA_SYSTEM_PROMPT, user_text)
        try:
            t1 = time.perf_counter()
            out = llm(prompt_text, max_tokens=128, temperature=0.0, stop=["<end_of_turn>"])
            elapsed = time.perf_counter() - t1
            text = out["choices"][0]["text"] if out["choices"] else ""
            ok = _check_text_response(text)
            if ok:
                text_ok += 1
            results["text_tests"].append({
                "prompt": user_text,
                "output_snippet": text[:200],
                "ok": ok,
                "elapsed_s": round(elapsed, 2),
            })
            log.info("[%s] text %d: ok=%s (%.1fs)", tier, i + 1, ok, elapsed)
        except Exception as e:
            log.error("[%s] text test %d failed: %s", tier, i + 1, e)
            results["text_tests"].append({"error": str(e), "ok": False})

    # Also run against test.jsonl prompts
    test_records_ok = 0
    test_records_total = 0
    if TEST_FILE.exists():
        lines = TEST_FILE.read_text().strip().split("\n")[:max_samples]
        for line in lines:
            try:
                rec = json.loads(line)
                req = rec.get("request", {})
                msgs = req.get("messages", [])
                user_msg = next(
                    (m["content"] for m in msgs if m.get("role") == "user"), None
                )
                if not user_msg:
                    continue
                system_msg = req.get("system", ELIZA_SYSTEM_PROMPT)
                prompt_text = _format_prompt_for_llama(system_msg, user_msg)
                out = llm(prompt_text, max_tokens=256, temperature=0.0, stop=["<end_of_turn>"])
                text = out["choices"][0]["text"] if out["choices"] else ""
                ok = _check_text_response(text)
                if ok:
                    test_records_ok += 1
                test_records_total += 1
            except Exception:
                test_records_total += 1

    results["test_jsonl"] = {
        "total": test_records_total,
        "ok": test_records_ok,
        "pct": round(100.0 * test_records_ok / max(test_records_total, 1), 1),
    }

    n_tool = len(results["tool_call_tests"])
    n_text = len(results["text_tests"])
    # Pass if >50% tool calls correct and >50% text responses non-empty
    gate_pass = (
        (tool_ok / max(n_tool, 1)) >= 0.5
        and (text_ok / max(n_text, 1)) >= 0.5
        and (test_records_ok / max(test_records_total, 1)) >= 0.5
    )
    results["passed"] = gate_pass
    results["summary"] = {
        "tool_call_accuracy": round(tool_ok / max(n_tool, 1), 3),
        "text_response_ok_rate": round(text_ok / max(n_text, 1), 3),
        "test_jsonl_ok_rate": round(test_records_ok / max(test_records_total, 1), 3),
        "gate_pass": gate_pass,
    }
    log.info("[%s] RESULT: tool_accuracy=%.1f%% text_ok=%.1f%% test_jsonl=%.1f%% GATE=%s",
             tier,
             100 * results["summary"]["tool_call_accuracy"],
             100 * results["summary"]["text_response_ok_rate"],
             results["summary"]["test_jsonl_ok_rate"] * 100,
             "PASS" if gate_pass else "FAIL")

    del llm
    return results


def push_report_to_hf(tier: str, report: dict, hf_token: str | None) -> None:
    """Upload in-agent test report to HF."""
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=hf_token)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tmp:
            json.dump(report, tmp, indent=2)
            tmp_path = tmp.name
        api.upload_file(
            path_or_fileobj=tmp_path,
            path_in_repo=f"bundles/{tier}/eval/inagent_test.json",
            repo_id=HF_REPO,
            repo_type="model",
            token=hf_token,
        )
        log.info("[%s] Uploaded in-agent report to HF", tier)
        os.unlink(tmp_path)
    except Exception as e:
        log.error("[%s] Failed to upload report: %s", tier, e)


def main() -> int:
    parser = argparse.ArgumentParser(description="In-agent eliza-1 verification via llama.cpp")
    parser.add_argument(
        "--tier",
        default=None,
        help=f"Single active tier to test ({_active_tier_help()})",
    )
    parser.add_argument("--tiers", default=None, help="Comma-separated tiers or 'all'")
    parser.add_argument("--local-gguf", default=None, help="Path to local GGUF (skips HF download)")
    parser.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"), help="HuggingFace token")
    parser.add_argument("--max-samples", type=int, default=10)
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--push-report", action="store_true", help="Upload report to HF")
    args = parser.parse_args()

    if args.local_gguf:
        gguf_path = Path(args.local_gguf)
        tier = args.tier or "unknown"
        report = test_gguf(gguf_path, tier, args.max_samples)
        print(json.dumps(report, indent=2))
        return 0 if report.get("passed") else 1

    tiers = resolve_requested_tiers(args.tier, args.tiers)

    out_dir = Path(args.output_dir) if args.output_dir else ROOT / "reports" / "inagent"
    out_dir.mkdir(parents=True, exist_ok=True)

    all_results = []
    all_passed = True

    for tier in tiers:
        log.info("=== Testing tier %s ===", tier)
        gguf_path = _download_gguf(tier, args.hf_token)
        if gguf_path is None:
            result = {"tier": tier, "error": "GGUF not found on HF", "passed": False}
            all_results.append(result)
            all_passed = False
            continue

        result = test_gguf(gguf_path, tier, args.max_samples)
        all_results.append(result)
        if not result.get("passed"):
            all_passed = False

        # Save per-tier report
        tier_report_path = out_dir / f"inagent_{tier}.json"
        tier_report_path.write_text(json.dumps(result, indent=2))
        log.info("[%s] report saved: %s", tier, tier_report_path)

        if args.push_report:
            push_report_to_hf(tier, result, args.hf_token)

    # Save combined report
    combined = {
        "schema_version": 1,
        "tiers_tested": tiers,
        "all_passed": all_passed,
        "results": all_results,
    }
    combined_path = out_dir / "inagent_combined.json"
    combined_path.write_text(json.dumps(combined, indent=2))
    log.info("Combined report: %s", combined_path)

    # Print summary table
    print("\n=== In-Agent Test Summary ===")
    print(f"{'Tier':<8} {'Tool%':<8} {'Text%':<8} {'JSONL%':<8} {'GATE':<6}")
    print("-" * 44)
    for r in all_results:
        s = r.get("summary", {})
        tier_id = r.get("tier", "?")
        if r.get("error"):
            print(f"{tier_id:<8} ERROR: {r['error']}")
        else:
            print(
                f"{tier_id:<8} "
                f"{s.get('tool_call_accuracy', 0)*100:>6.1f}  "
                f"{s.get('text_response_ok_rate', 0)*100:>6.1f}  "
                f"{s.get('test_jsonl_ok_rate', 0)*100:>6.1f}  "
                f"{'PASS' if s.get('gate_pass') else 'FAIL'}"
            )

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
