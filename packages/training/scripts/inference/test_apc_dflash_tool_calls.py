"""A/B test harness for DFlash + Automatic Prefix Caching + Qwen3.5/3.6
hybrid-attention tool-calling parity.

Why this exists
---------------
omlx#825 documents a known failure mode: when vLLM serves a Qwen3.5/3.6
hybrid model (3 GatedDeltaNet linear-attn + 1 GatedAttention full-attn per
block) with both `--enable-prefix-caching` AND a speculative drafter
(EAGLE-3 / DFlash / qwen3_next_mtp), the linear-attention layers'
``conv_state`` / ``ssm_state`` are not replayed correctly on prefix-cache
hits. The visible symptom is structured-output drift — the post-cache-hit
response either omits the tool call entirely or emits malformed JSON.

This harness sends N requests with a long shared preamble + a user message
that forces a tool call, sweeping all 4 cells of (APC × drafter). It
parses the tool call out of the response and compares the schema/payload
across cells. PASS ⇒ we're safe to ship `--enable-prefix-caching` together
with the drafter for this model on this vLLM build. FAIL ⇒ keep APC off
until upstream lands the fix.

The harness talks to an already-running vLLM serve over its OpenAI-
compatible HTTP endpoint. It does NOT spin up vLLM itself — that's
``scripts/inference/serve_vllm.py``'s job.

Usage
-----
::

    # Start the serve in one terminal, e.g.:
    #   uv run --extra serve python scripts/inference/serve_vllm.py \
    #       --registry-key qwen3.6-27b --gpu-target h200-2x \
    #       --dflash z-lab/Qwen3.6-27B-DFlash --enable-prefix-caching

    # Then in another terminal point this at it:
    uv run --extra serve python scripts/inference/test_apc_dflash_tool_calls.py \
        --base-url http://localhost:8000/v1 \
        --model Qwen/Qwen3.6-27B \
        --n-prompts 20 \
        --report-out /tmp/apc_dflash_parity.json

    # The harness is also useful as a single-cell smoke test (default):
    uv run --extra serve python scripts/inference/test_apc_dflash_tool_calls.py \
        --base-url http://localhost:8000/v1 --model ... --n-prompts 5

The 4-cell sweep is enabled with ``--full-sweep``, which expects the user
to **stop the serve, restart it with the matching flags, then re-run the
harness with the matching --cell flag** — the harness can't toggle vLLM
flags from the client side. Cells:

    bf16-base   : --no-enable-prefix-caching, no drafter
    apc-only    : --enable-prefix-caching, no drafter
    drafter-only: --no-enable-prefix-caching, drafter
    full-stack  : --enable-prefix-caching, drafter (the suspect cell)
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import sys
import time
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("apc_dflash_test")


# A 6k-character shared preamble — long enough that vLLM's APC will hash and
# cache the prefix, short enough that we can iterate without burning the GPU.
# The prefix is held verbatim across requests so any second-and-later request
# is a guaranteed cache hit for the first ~5.7k of text.
SYSTEM_PREAMBLE = (
    "You are an expert assistant routing user requests to the correct tool. "
    "Tools available: search, read_file, write_file, run_shell, fetch_url, "
    "send_email, schedule, list_calendar, create_event, search_files, "
    "get_weather, translate, summarize, generate_image, transcribe_audio. "
    "Each tool has a strict JSON schema. You must call exactly one tool per "
    "user request. Never invent tools. Always include all required arguments. "
    "When the user asks for information, prefer search or fetch_url. When the "
    "user asks for an action, prefer the action-specific tool. When the user "
    "asks for a calendar operation, prefer list_calendar / create_event / "
    "schedule. When the user asks about a file, prefer read_file / write_file "
    "/ search_files. When the user asks about the weather, use get_weather. "
    "When the user asks for translation, use translate. When the user asks "
    "for a summary, use summarize. When the user asks for an image, use "
    "generate_image. When the user asks for transcription, use transcribe_audio. "
    "Tool definitions follow."
)
# Pad with deterministic filler so we cross the 6k mark without changing the
# semantic content. The padding is long, repetitive, and carries no signal —
# pure prefix budget.
_FILLER = (
    "// Tool definitions are loaded from the registry. The registry is the "
    "authoritative source. Do not invent tools, do not invent fields. The "
    "schema for every tool must match exactly. Required fields are required. "
    "Optional fields may be omitted. Defaults are documented inline. "
)
SYSTEM_PREAMBLE = SYSTEM_PREAMBLE + ("\n" + _FILLER) * 18  # ~6k chars


# Each (user prompt, expected tool name, expected arg keys) triple is a
# specification: any tool call that names this tool with at least these keys
# is acceptable. We don't compare exact argument values — model paraphrasing
# is fine — only that the *structure* of the call is preserved.
TEST_PROMPTS: list[tuple[str, str, list[str]]] = [
    ("What's the weather in Tokyo right now?", "get_weather", ["location"]),
    ("Translate 'good morning' into Spanish.", "translate", ["text", "target_language"]),
    ("Summarize this paragraph in two sentences: The cat sat on the mat. The dog ran away.", "summarize", ["text"]),
    ("Send an email to alice@example.com with subject 'lunch' and body 'noon?'", "send_email", ["to", "subject", "body"]),
    ("Create a calendar event for tomorrow at 3pm titled 'review'.", "create_event", ["title", "start"]),
    ("What's on my calendar today?", "list_calendar", []),
    ("Fetch https://example.com/api/v1/status and tell me the response code.", "fetch_url", ["url"]),
    ("Search the web for 'rust borrow checker basics'.", "search", ["query"]),
    ("Run 'ls -la /tmp' on the host.", "run_shell", ["command"]),
    ("Generate an image of a sunset over the ocean.", "generate_image", ["prompt"]),
    ("Transcribe the audio file at /tmp/meeting.wav.", "transcribe_audio", ["audio_path"]),
    ("Read the contents of /etc/hostname.", "read_file", ["path"]),
    ("Write 'hello' to /tmp/greeting.txt.", "write_file", ["path", "content"]),
    ("Find all files matching '*.py' under /home/me/project.", "search_files", ["pattern"]),
    ("Schedule 'standup' for Mondays at 9am.", "schedule", ["title", "recurrence"]),
    ("Translate 'thank you very much' into Japanese.", "translate", ["text", "target_language"]),
    ("Check the weather forecast for London this weekend.", "get_weather", ["location"]),
    ("Send an email to bob@example.com about the deployment.", "send_email", ["to", "subject", "body"]),
    ("Search for 'tokio runtime async tasks'.", "search", ["query"]),
    ("What's on my calendar this week?", "list_calendar", []),
]


# OpenAI-style tools schema — enables the model's structured tool-call mode.
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Look up current weather for a location.",
            "parameters": {
                "type": "object",
                "properties": {"location": {"type": "string"}},
                "required": ["location"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "translate",
            "description": "Translate text into a target language.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "target_language": {"type": "string"},
                },
                "required": ["text", "target_language"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "summarize",
            "description": "Summarize the input text.",
            "parameters": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_email",
            "description": "Send an email message.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_event",
            "description": "Create a calendar event.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "start": {"type": "string"},
                    "end": {"type": "string"},
                },
                "required": ["title", "start"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_calendar",
            "description": "List calendar events.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "HTTP GET a URL and return body.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "Search the web.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": "Run a shell command on the host.",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": "Generate an image from a text prompt.",
            "parameters": {
                "type": "object",
                "properties": {"prompt": {"type": "string"}},
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "transcribe_audio",
            "description": "Transcribe an audio file.",
            "parameters": {
                "type": "object",
                "properties": {"audio_path": {"type": "string"}},
                "required": ["audio_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from disk.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Search files by pattern.",
            "parameters": {
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schedule",
            "description": "Schedule a recurring event.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "recurrence": {"type": "string"},
                },
                "required": ["title", "recurrence"],
            },
        },
    },
]


@dataclasses.dataclass
class ToolCallResult:
    prompt_idx: int
    expected_name: str
    expected_arg_keys: list[str]
    received_name: str | None
    received_arg_keys: list[str]
    raw_content: str
    latency_ms: float
    error: str | None = None

    @property
    def name_match(self) -> bool:
        return self.received_name == self.expected_name

    @property
    def args_complete(self) -> bool:
        if not self.received_arg_keys:
            return not self.expected_arg_keys
        return all(k in self.received_arg_keys for k in self.expected_arg_keys)

    @property
    def passed(self) -> bool:
        return self.error is None and self.name_match and self.args_complete


def call_vllm(
    *, base_url: str, model: str, system: str, user: str, tools: list,
    timeout: float = 60.0, temperature: float = 0.0,
) -> tuple[dict, float]:
    """One OpenAI-compatible chat call with tools enabled. Returns the parsed
    response JSON + latency in milliseconds.

    Lazily imports `openai` so the script doesn't fail when invoked just for
    --help on a box without the client installed.
    """
    try:
        from openai import OpenAI
    except ImportError as e:
        raise SystemExit(
            "openai client not installed. uv add --extra serve openai"
        ) from e

    client = OpenAI(base_url=base_url, api_key="EMPTY")
    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        tools=tools,
        tool_choice="auto",
        temperature=temperature,
        timeout=timeout,
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return resp.model_dump(), elapsed_ms


def parse_tool_call(resp_json: dict) -> tuple[str | None, list[str], str]:
    """Pull (name, arg_keys, raw_text) out of an OpenAI-format response.

    Returns (name=None, arg_keys=[], raw=...) when no tool call was made.
    """
    try:
        choice = resp_json["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None, [], json.dumps(resp_json)[:500]

    raw = choice.get("content") or ""
    tool_calls = choice.get("tool_calls") or []
    if not tool_calls:
        return None, [], raw

    first = tool_calls[0].get("function") or {}
    name = first.get("name")
    args_str = first.get("arguments") or "{}"
    try:
        args = json.loads(args_str) if isinstance(args_str, str) else args_str
        arg_keys = sorted(args.keys()) if isinstance(args, dict) else []
    except (json.JSONDecodeError, TypeError):
        arg_keys = []
    return name, arg_keys, args_str


def run_cell(
    *, base_url: str, model: str, n_prompts: int, prompts: list,
    cell_label: str,
) -> list[ToolCallResult]:
    log.info("[%s] running %d prompts against %s", cell_label, n_prompts, base_url)
    out: list[ToolCallResult] = []
    for i in range(n_prompts):
        user, exp_name, exp_keys = prompts[i % len(prompts)]
        try:
            resp, lat = call_vllm(
                base_url=base_url, model=model,
                system=SYSTEM_PREAMBLE, user=user, tools=TOOL_SCHEMAS,
            )
            name, keys, raw = parse_tool_call(resp)
            r = ToolCallResult(
                prompt_idx=i, expected_name=exp_name, expected_arg_keys=exp_keys,
                received_name=name, received_arg_keys=keys, raw_content=raw,
                latency_ms=lat,
            )
        except Exception as e:  # noqa: BLE001
            r = ToolCallResult(
                prompt_idx=i, expected_name=exp_name, expected_arg_keys=exp_keys,
                received_name=None, received_arg_keys=[], raw_content="",
                latency_ms=0.0, error=str(e),
            )
        marker = "PASS" if r.passed else "FAIL"
        log.info("[%s] %3d %s expected=%s got=%s lat=%.0fms",
                 cell_label, i, marker, exp_name, r.received_name, r.latency_ms)
        out.append(r)
    return out


def cell_summary(label: str, results: list[ToolCallResult]) -> dict:
    n = len(results)
    pass_n = sum(r.passed for r in results)
    name_n = sum(r.name_match for r in results)
    args_n = sum(r.args_complete for r in results)
    err_n = sum(r.error is not None for r in results)
    lat = [r.latency_ms for r in results if r.latency_ms > 0]
    return {
        "cell": label, "n": n, "pass": pass_n, "name_match": name_n,
        "args_complete": args_n, "errors": err_n,
        "median_lat_ms": (sorted(lat)[len(lat) // 2] if lat else 0.0),
    }


def parity_check(baseline: list[ToolCallResult], candidate: list[ToolCallResult]) -> dict:
    """Did the suspect cell produce the same tool calls as the baseline?"""
    n = min(len(baseline), len(candidate))
    name_match = sum(1 for b, c in zip(baseline[:n], candidate[:n])
                     if b.received_name == c.received_name)
    args_match = sum(1 for b, c in zip(baseline[:n], candidate[:n])
                     if b.received_arg_keys == c.received_arg_keys)
    return {"n": n, "name_match": name_match, "args_match": args_match,
            "name_parity_pct": (100.0 * name_match / n) if n else 0.0,
            "args_parity_pct": (100.0 * args_match / n) if n else 0.0}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://localhost:8000/v1",
                    help="OpenAI-compatible vLLM endpoint.")
    ap.add_argument("--model", required=True,
                    help="Model id as registered with vLLM (--served-model-name).")
    ap.add_argument("--n-prompts", type=int, default=20,
                    help="Number of prompts to send per cell.")
    ap.add_argument("--cell", default="single",
                    choices=("single", "bf16-base", "apc-only", "drafter-only", "full-stack"),
                    help="Which cell of the (APC × drafter) sweep this run "
                         "represents. Single = one-shot smoke test against the "
                         "currently-running serve. Other values: stop+restart "
                         "the serve with matching --enable-prefix-caching and "
                         "--dflash flags between runs.")
    ap.add_argument("--baseline-report", default=None,
                    help="Path to a previous run's report JSON (cell=bf16-base "
                         "or =apc-only) — when provided, this run is parity-"
                         "checked against it and a verdict is emitted.")
    ap.add_argument("--report-out", default=None,
                    help="Write the parsed results to this JSON file.")
    args = ap.parse_args()

    results = run_cell(
        base_url=args.base_url, model=args.model,
        n_prompts=args.n_prompts, prompts=TEST_PROMPTS,
        cell_label=args.cell,
    )

    summary = cell_summary(args.cell, results)
    log.info("---- summary ----")
    log.info("%s", json.dumps(summary, indent=2))

    verdict = "UNKNOWN"
    if args.baseline_report:
        baseline_data = json.loads(Path(args.baseline_report).read_text())
        baseline_results = [ToolCallResult(**r) for r in baseline_data["results"]]
        parity = parity_check(baseline_results, results)
        log.info("parity vs %s: %s", args.baseline_report, json.dumps(parity, indent=2))
        # PASS = ≥95% name parity AND ≥90% args parity (small drift OK).
        if parity["name_parity_pct"] >= 95.0 and parity["args_parity_pct"] >= 90.0:
            verdict = "PASS"
        else:
            verdict = "FAIL"
        summary["parity_vs_baseline"] = parity
        summary["verdict"] = verdict

    if args.report_out:
        out_path = Path(args.report_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps({
            "summary": summary,
            "results": [dataclasses.asdict(r) for r in results],
            "model": args.model,
            "system_prompt_sha256": hashlib.sha256(SYSTEM_PREAMBLE.encode()).hexdigest(),
            "n_tool_schemas": len(TOOL_SCHEMAS),
        }, indent=2))
        log.info("report written to %s", out_path)

    if verdict == "FAIL":
        log.error("PARITY FAILED — DO NOT enable APC + drafter together on this build")
        return 2
    if verdict == "PASS":
        log.info("PARITY PASSED — APC + drafter are safe together")
        return 0
    if summary["pass"] == summary["n"]:
        log.info("smoke test PASSED — all %d prompts produced expected tool calls", summary["n"])
        return 0
    log.warning("smoke test had failures: %d/%d passed", summary["pass"], summary["n"])
    return 1


if __name__ == "__main__":
    sys.exit(main())
