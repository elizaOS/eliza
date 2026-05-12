"""Trajectory token + prompt-cache analyzer.

Walks a benchmark run directory looking for trajectory artifacts written by
the bench server (and a few other shapes already in use in the repo) and
summarizes:

  * total prompt / completion / total tokens
  * total cached prompt tokens, plus cache-hit ratio
  * approximate count of long-repeated prompt prefixes (sliding-window hash
    over each turn's prompt text)

Usage:
    python -m benchmarks.orchestrator.analyze_trajectory <run_dir>
        [--window 200] [--min-repeats 2] [--top 20] [--json]

The script is deliberately tolerant: it scans for any `trajectory*.json`,
`trajectory*.jsonl`, or `trajectories.jsonl` file under the run directory and
folds whatever per-turn token info it can find. Recognised per-turn keys:

  * `usage` (BenchmarkTurnUsage shape — bench server, post May 2026)
  * `usage.calls[].promptTokens` / `completionTokens` / `cachedTokens`
  * `prompt_tokens` / `completion_tokens` / `cached_tokens` (adhdbench shape)
  * `tokens.prompt` / `tokens.completion` / `tokens.cached` (legacy shape)

Run standalone or via `python -m`. No third-party dependencies.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass
class TurnTokens:
    prompt: int = 0
    completion: int = 0
    cached: int = 0
    cache_creation: int = 0
    has_cached: bool = False


@dataclass
class TurnRecord:
    file: str
    index: int
    prompt_text: str
    tokens: TurnTokens
    latency_ms: float | None = None


@dataclass
class RunSummary:
    turns: int = 0
    files: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    cache_creation_tokens: int = 0
    turns_with_cached_field: int = 0
    cache_hit_ratio: float = 0.0
    prompt_chars: int = 0
    mean_latency_ms: float | None = None
    p95_latency_ms: float | None = None
    repeated_prefixes: list[tuple[str, int]] = field(default_factory=list)


def _coerce_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _coerce_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _token_detail_value(usage: dict[str, Any], keys: tuple[str, ...]) -> int:
    for container_key in ("prompt_tokens_details", "input_token_details", "token_details"):
        details = usage.get(container_key)
        if not isinstance(details, dict):
            continue
        for key in keys:
            if key in details:
                return _coerce_int(details.get(key))
    return 0


def _nested_dict(obj: dict[str, Any], path: tuple[str, ...]) -> dict[str, Any] | None:
    current: Any = obj
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current if isinstance(current, dict) else None


def extract_tokens(obj: dict[str, Any]) -> TurnTokens | None:
    """Pull a TurnTokens out of one trajectory entry, or None if no signal."""

    # Shape 1: bench-server post-May-2026 — `usage: BenchmarkTurnUsage`.
    usage = obj.get("usage")
    if isinstance(usage, dict):
        prompt = _coerce_int(usage.get("promptTokens") or usage.get("prompt_tokens"))
        completion = _coerce_int(
            usage.get("completionTokens")
            or usage.get("completion_tokens")
            or usage.get("output_tokens")
        )
        if not prompt:
            prompt = _coerce_int(usage.get("input_tokens"))
        cached_raw = (
            usage.get("cachedTokens")
            or usage.get("cached_tokens")
            or usage.get("cache_read_input_tokens")
            or _token_detail_value(usage, ("cached_tokens", "cache_read_input_tokens"))
        )
        cache_creation = _coerce_int(
            usage.get("cacheCreationInputTokens")
            or usage.get("cache_creation_input_tokens")
            or _token_detail_value(usage, ("cache_creation_input_tokens", "cache_write_tokens"))
        )
        has_cached = cached_raw is not None
        cached = _coerce_int(cached_raw)
        if prompt or completion or cached or cache_creation:
            return TurnTokens(
                prompt=prompt,
                completion=completion,
                cached=cached,
                cache_creation=cache_creation,
                has_cached=has_cached,
            )

    # Shape 1c: nested raw harness output, e.g. VisualWebBench stores
    # prediction.raw_output.params.usage instead of promoting usage to the
    # trace root.
    for path in (
        ("params", "usage"),
        ("raw_output", "params", "usage"),
        ("prediction", "raw_output", "params", "usage"),
        ("provider_payload", "usage"),
    ):
        nested_usage = _nested_dict(obj, path)
        if nested_usage is None:
            continue
        nested_tokens = extract_tokens({"usage": nested_usage})
        if nested_tokens is not None:
            return nested_tokens

    for path in (("usage_tracking",), ("provider_payload", "usage_tracking")):
        current: Any = obj
        for key in path:
            if not isinstance(current, dict):
                current = None
                break
            current = current.get(key)
        if not isinstance(current, list) or not current:
            continue
        prompt = 0
        completion = 0
        cached = 0
        cache_creation = 0
        has_cached = False
        for item in current:
            if not isinstance(item, dict):
                continue
            prompt += _coerce_int(item.get("prompt_tokens") or item.get("promptTokens"))
            completion += _coerce_int(
                item.get("completion_tokens")
                or item.get("completionTokens")
                or item.get("output_tokens")
            )
            cached_raw = (
                item.get("prompt_cache_hit_tokens")
                or item.get("cache_read_input_tokens")
                or item.get("cached_tokens")
            )
            if cached_raw is not None:
                has_cached = True
                cached += _coerce_int(cached_raw)
            cache_creation += _coerce_int(
                item.get("prompt_cache_miss_tokens")
                or item.get("cache_creation_input_tokens")
            )
        if prompt or completion or cached or cache_creation:
            return TurnTokens(
                prompt=prompt,
                completion=completion,
                cached=cached,
                cache_creation=cache_creation,
                has_cached=has_cached,
            )

    # Shape 1b: benchmark summary metrics that only expose aggregate totals.
    for metrics_key in ("metrics", "overall_metrics"):
        metrics = obj.get(metrics_key)
        if not isinstance(metrics, dict):
            continue
        total = _coerce_int(metrics.get("tokens_used") or metrics.get("total_tokens"))
        if total:
            return TurnTokens(prompt=total)

    # Shape 2: per-call list — `usage.calls[]`.
    if isinstance(usage, dict):
        calls = usage.get("calls")
        if isinstance(calls, list) and calls:
            prompt = sum(_coerce_int(c.get("promptTokens")) for c in calls if isinstance(c, dict))
            completion = sum(
                _coerce_int(c.get("completionTokens")) for c in calls if isinstance(c, dict)
            )
            cached = 0
            cache_creation = 0
            has_cached = False
            for c in calls:
                if isinstance(c, dict) and c.get("cachedTokens") is not None:
                    cached += _coerce_int(c.get("cachedTokens"))
                    has_cached = True
                if isinstance(c, dict):
                    cache_creation += _coerce_int(
                        c.get("cacheCreationInputTokens")
                        or c.get("cache_creation_input_tokens")
                    )
            if prompt or completion or cached or cache_creation:
                return TurnTokens(
                    prompt=prompt,
                    completion=completion,
                    cached=cached,
                    cache_creation=cache_creation,
                    has_cached=has_cached,
                )

    # Shape 3: adhdbench-like flat fields.
    if "prompt_tokens" in obj or "completion_tokens" in obj or "cached_tokens" in obj:
        prompt = _coerce_int(obj.get("prompt_tokens"))
        completion = _coerce_int(obj.get("completion_tokens"))
        cached_raw = obj.get("cached_tokens")
        has_cached = cached_raw is not None
        cached = _coerce_int(cached_raw)
        if prompt or completion or cached:
            return TurnTokens(
                prompt=prompt,
                completion=completion,
                cached=cached,
                cache_creation=_coerce_int(obj.get("cache_creation_input_tokens")),
                has_cached=has_cached,
            )

    # Shape 3b: benchmark result turns (LifeOps, some tool-use reports).
    if "input_tokens" in obj or "output_tokens" in obj:
        prompt = _coerce_int(obj.get("input_tokens"))
        completion = _coerce_int(obj.get("output_tokens"))
        if prompt or completion:
            return TurnTokens(prompt=prompt, completion=completion)

    if "token_usage" in obj or "tokens_used" in obj:
        token_usage = obj.get("token_usage")
        if isinstance(token_usage, dict):
            prompt = _coerce_int(
                token_usage.get("prompt_tokens")
                or token_usage.get("promptTokens")
                or token_usage.get("input_tokens")
            )
            completion = _coerce_int(
                token_usage.get("completion_tokens")
                or token_usage.get("completionTokens")
                or token_usage.get("output_tokens")
            )
            cached_raw = (
                token_usage.get("cached_prompt_tokens")
                or token_usage.get("cachedTokens")
                or token_usage.get("cached_tokens")
                or token_usage.get("cache_read_input_tokens")
            )
            cached = _coerce_int(cached_raw)
            cache_creation = _coerce_int(
                token_usage.get("cache_creation_input_tokens")
                or token_usage.get("cacheCreationInputTokens")
            )
            if prompt or completion or cached or cache_creation:
                return TurnTokens(
                    prompt=prompt,
                    completion=completion,
                    cached=cached,
                    cache_creation=cache_creation,
                    has_cached=cached_raw is not None,
                )
        total = _coerce_int(token_usage or obj.get("tokens_used"))
        if total:
            return TurnTokens(prompt=total)

    for key in ("total_tokens", "totalTokens", "tokens_used", "tokensUsed"):
        total = _coerce_int(obj.get(key))
        if total:
            return TurnTokens(prompt=total)

    # Shape 4: nested `tokens` dict.
    tokens = obj.get("tokens")
    if isinstance(tokens, dict):
        prompt = _coerce_int(tokens.get("prompt"))
        completion = _coerce_int(tokens.get("completion"))
        cached_raw = tokens.get("cached")
        has_cached = cached_raw is not None
        cached = _coerce_int(cached_raw)
        cache_creation = _coerce_int(tokens.get("cache_creation"))
        if prompt or completion or cached or cache_creation:
            return TurnTokens(
                prompt=prompt,
                completion=completion,
                cached=cached,
                cache_creation=cache_creation,
                has_cached=has_cached,
            )

    return None


def extract_prompt(obj: dict[str, Any]) -> str:
    for key in (
        "promptText",
        "prompt_text",
        "prompt",
        "user_text",
        "inputText",
        "question",
        "agent_message",
        "message",
        "response",
        "response_text",
        "predicted",
        "prediction",
        "predicted_answer",
        "expected_answer",
        "instruction",
        "task_id",
        "task_name",
        "sampleId",
        "sample_id",
        "case_id",
        "template_key",
        "website",
        "expectedTranscript",
        "scenario_id",
    ):
        v = obj.get(key)
        if isinstance(v, str):
            return v
    return ""


def extract_latency_ms(obj: dict[str, Any]) -> float | None:
    for key in ("duration_seconds", "durationSeconds", "elapsed_seconds", "elapsedSeconds"):
        value = _coerce_float(obj.get(key))
        if value is not None:
            return value * 1000.0
    duration = _coerce_float(obj.get("duration"))
    if duration is not None and (
        "timestamp" in obj
        or "instance_id" in obj
        or "patch_status" in obj
    ):
        return duration * 1000.0
    for key in (
        "latency_ms",
        "latencyMs",
        "duration_ms",
        "durationMs",
        "total_execution_time_ms",
        "totalExecutionTimeMs",
        "totalTimeMs",
        "elapsed_ms",
        "response_ms",
        "responseTotalMs",
        "transcriptionMs",
        "average_latency_ms",
        "avg_duration_ms",
        "average_duration_ms",
    ):
        value = _coerce_float(obj.get(key))
        if value is not None:
            return value
    usage = obj.get("usage")
    if isinstance(usage, dict):
        for key in ("latency_ms", "latencyMs", "duration_ms", "durationMs", "elapsed_ms"):
            value = _coerce_float(usage.get(key))
            if value is not None:
                return value
    metrics = obj.get("metrics")
    if isinstance(metrics, dict):
        for key in ("avg_duration_ms", "average_duration_ms", "duration_ms"):
            value = _coerce_float(metrics.get(key))
            if value is not None:
                return value
    latency = obj.get("latency")
    if isinstance(latency, dict):
        for key in ("avg_ms", "average_ms", "median_ms", "p95_ms"):
            value = _coerce_float(latency.get(key))
            if value is not None:
                return value
    return None


def iter_turn_objs(path: Path) -> Iterable[dict[str, Any]]:
    """Yield turn dicts from a json/jsonl trajectory file."""

    if path.suffix == ".jsonl" or path.name.endswith(".jsonl"):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                case_result = obj.get("case_result")
                if isinstance(case_result, dict):
                    yield case_result
                    cycles = case_result.get("cycles")
                    if isinstance(cycles, list):
                        for cycle in cycles:
                            if isinstance(cycle, dict):
                                yield cycle
                    continue
                yield obj
        return

    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return

    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                yield item
        return
    if isinstance(data, dict):
        case_result = data.get("case_result")
        if isinstance(case_result, dict):
            yield case_result
            cycles = case_result.get("cycles")
            if isinstance(cycles, list):
                for item in cycles:
                    if isinstance(item, dict):
                        yield item
            return
        # Common shapes: {"steps":[...]} or {"turns":[...]} or single turn.
        for key in ("steps", "turns", "trajectory", "messages"):
            seq = data.get(key)
            if isinstance(seq, list):
                for item in seq:
                    if isinstance(item, dict):
                        yield item
                return
        detailed = data.get("detailed_results")
        if isinstance(detailed, list):
            for item in detailed:
                if isinstance(item, dict):
                    yield item
            return
        orchestrated = data.get("orchestrated")
        if isinstance(orchestrated, dict):
            yielded = False
            for provider_payload in orchestrated.values():
                if not isinstance(provider_payload, dict):
                    continue
                provider_results = provider_payload.get("results")
                if not isinstance(provider_results, list):
                    continue
                for item in provider_results:
                    if isinstance(item, dict):
                        yielded = True
                        yield item
            if yielded:
                return
        results = data.get("results")
        if isinstance(results, list):
            for item in results:
                if isinstance(item, dict):
                    turns = item.get("turns")
                    if isinstance(turns, list):
                        for turn in turns:
                            if isinstance(turn, dict):
                                yield turn
                        continue
                    yield item
            return
        for key in ("failures", "refusals", "task_results"):
            seq = data.get(key)
            if not isinstance(seq, list):
                continue
            for item in seq:
                if isinstance(item, dict):
                    yield item
            return
        for key in ("baseline_results", "tools_only_results", "feedback_only_results", "full_results"):
            nested = data.get(key)
            if not isinstance(nested, dict):
                continue
            seq = nested.get("task_results")
            if not isinstance(seq, list):
                continue
            for item in seq:
                if isinstance(item, dict):
                    yield item
            return
        handlers = data.get("handlers")
        if isinstance(handlers, list):
            yielded = False
            for handler in handlers:
                if not isinstance(handler, dict):
                    continue
                scenarios = handler.get("scenarios")
                if isinstance(scenarios, list):
                    for scenario in scenarios:
                        if isinstance(scenario, dict):
                            yielded = True
                            yield scenario
                elif "totalTimeMs" in handler:
                    yielded = True
                    yield handler
            if yielded:
                return
        reports = data.get("environment_reports")
        if isinstance(reports, dict):
            for item in reports.values():
                if isinstance(item, dict):
                    yield item
            return
        transcripts = data.get("transcripts")
        if isinstance(transcripts, dict):
            for seq in transcripts.values():
                if not isinstance(seq, list):
                    continue
                for item in seq:
                    if isinstance(item, dict):
                        yield item
            return
        if isinstance(transcripts, list):
            for item in transcripts:
                if isinstance(item, dict):
                    yield item
            return
        scenarios = data.get("scenarios")
        if isinstance(scenarios, dict):
            yielded = False
            for scenario_id, scenario in scenarios.items():
                if isinstance(scenario, dict):
                    scenario.setdefault("scenario_id", str(scenario_id))
                    yielded = True
                    yield scenario
            if yielded:
                return
        if isinstance(scenarios, list):
            for scenario in scenarios:
                if not isinstance(scenario, dict):
                    continue
                turns = scenario.get("turns")
                if not isinstance(turns, list):
                    yield scenario
                    continue
                for item in turns:
                    if isinstance(item, dict):
                        yield item
            return
        yield data


def discover_trajectories(run_dir: Path) -> list[Path]:
    patterns = (
        "**/trajectories.jsonl",
        "**/trajectory*.json",
        "**/trajectory*.jsonl",
        "**/trajectories*.json",
        "**/*_traces.jsonl",
        "**/*_traces.json",
        "**/*_traces_*.json",
        "**/*traces*.json",
        "**/*_trajectory.json",
        "**/traj.jsonl",
        "**/agentbench-results.json",
        "**/bfcl_results_*.json",
        "**/swe-bench-*.json",
        "**/orchestrated-*.json",
        "**/hyperliquid_bench-*.json",
        "**/eliza-replay-results.json",
        "**/metrics/evm_*_metrics.json",
        "**/evm_*_metrics.json",
        "**/eliza_*_metrics.json",
        "**/gaia-results*.json",
        "**/lifeops_*.json",
        "**/mind2web-results*.json",
        "**/orchestrator-lifecycle-*.json",
        "**/osworld-eliza-results-*.json",
        "**/webshop-detailed.json",
        "**/woobench_*.json",
        "**/vending-bench-results-*.json",
        "**/vending-bench-detailed-*.json",
        "**/summary.json",
        "**/*.jsonl",
        "**/*.json",
    )
    seen: set[Path] = set()
    out: list[Path] = []
    for pat in patterns:
        for p in run_dir.glob(pat):
            if p.is_file() and p not in seen:
                seen.add(p)
                out.append(p)
    return sorted(out)


def find_repeated_prefixes(
    prompts: list[str],
    window: int = 200,
    min_repeats: int = 2,
    top: int = 20,
) -> list[tuple[str, int]]:
    """Hash sliding windows across all prompt texts; return windows that
    recur >= min_repeats times, sorted by frequency."""

    counter: Counter[str] = Counter()
    for text in prompts:
        if not text or len(text) < window:
            continue
        # Stride window/4 to keep work manageable on long prompts; still
        # catches near-identical prefixes across turns. Use a finer stride
        # for short prompts to avoid missing overlap.
        stride = max(1, window // 4)
        for i in range(0, len(text) - window + 1, stride):
            counter[text[i : i + window]] += 1

    repeats = [(snippet, n) for snippet, n in counter.items() if n >= min_repeats]
    repeats.sort(key=lambda kv: (-kv[1], kv[0][:40]))
    return repeats[:top]


def summarize(
    run_dir: Path,
    window: int = 200,
    min_repeats: int = 2,
    top: int = 20,
) -> tuple[RunSummary, list[TurnRecord]]:
    summary = RunSummary()
    records: list[TurnRecord] = []
    files = discover_trajectories(run_dir)
    summary.files = len(files)

    for f in files:
        for idx, obj in enumerate(iter_turn_objs(f)):
            prompt_text = extract_prompt(obj)
            latency_ms = extract_latency_ms(obj)
            tokens = extract_tokens(obj)
            if tokens is None and not prompt_text and latency_ms is None:
                continue
            tokens = tokens or TurnTokens()
            records.append(
                TurnRecord(
                    file=str(f.relative_to(run_dir)),
                    index=idx,
                    prompt_text=prompt_text,
                    tokens=tokens,
                    latency_ms=latency_ms,
                )
            )
            summary.turns += 1
            summary.prompt_tokens += tokens.prompt
            summary.completion_tokens += tokens.completion
            summary.cached_tokens += tokens.cached
            summary.cache_creation_tokens += tokens.cache_creation
            if tokens.has_cached:
                summary.turns_with_cached_field += 1
            summary.prompt_chars += len(prompt_text)

    prompt_plus_cached = summary.prompt_tokens + summary.cached_tokens
    if prompt_plus_cached > 0:
        summary.cache_hit_ratio = summary.cached_tokens / prompt_plus_cached

    summary.repeated_prefixes = find_repeated_prefixes(
        [r.prompt_text for r in records],
        window=window,
        min_repeats=min_repeats,
        top=top,
    )
    latency_values = sorted(r.latency_ms for r in records if r.latency_ms is not None)
    if latency_values:
        summary.mean_latency_ms = sum(latency_values) / len(latency_values)
        p95_index = max(0, min(len(latency_values) - 1, int(round((len(latency_values) - 1) * 0.95))))
        summary.p95_latency_ms = latency_values[p95_index]
    return summary, records


def render_text(run_dir: Path, summary: RunSummary, window: int) -> str:
    lines: list[str] = []
    lines.append(f"Trajectory analysis: {run_dir}")
    lines.append(f"  trajectory files : {summary.files}")
    lines.append(f"  total turns      : {summary.turns}")
    lines.append(f"  prompt tokens    : {summary.prompt_tokens}")
    lines.append(f"  completion tokens: {summary.completion_tokens}")
    if summary.turns_with_cached_field:
        lines.append(
            f"  cached tokens    : {summary.cached_tokens} "
            f"({summary.turns_with_cached_field}/{summary.turns} turns reported a cached field)"
        )
        lines.append(f"  cache hit ratio  : {summary.cache_hit_ratio:.2%}")
    else:
        lines.append("  cached tokens    : (no turn reported a cached_tokens field)")
    lines.append(f"  cache creation   : {summary.cache_creation_tokens}")
    lines.append(f"  prompt chars     : {summary.prompt_chars}")
    if summary.mean_latency_ms is not None:
        lines.append(f"  mean latency ms  : {summary.mean_latency_ms:.2f}")
        lines.append(f"  p95 latency ms   : {summary.p95_latency_ms:.2f}")
    lines.append("")
    lines.append(f"Top repeated prompt prefixes (window={window} chars):")
    if not summary.repeated_prefixes:
        lines.append("  (none)")
    else:
        for snippet, count in summary.repeated_prefixes:
            preview = snippet.replace("\n", " ")[:80]
            lines.append(f"  x{count:<4} {preview}")
    return "\n".join(lines)


def render_json(summary: RunSummary, records: list[TurnRecord]) -> str:
    payload = {
        "files": summary.files,
        "turns": summary.turns,
        "prompt_tokens": summary.prompt_tokens,
        "completion_tokens": summary.completion_tokens,
        "cached_tokens": summary.cached_tokens,
        "cache_creation_tokens": summary.cache_creation_tokens,
        "turns_with_cached_field": summary.turns_with_cached_field,
        "cache_hit_ratio": summary.cache_hit_ratio,
        "prompt_chars": summary.prompt_chars,
        "mean_latency_ms": summary.mean_latency_ms,
        "p95_latency_ms": summary.p95_latency_ms,
        "repeated_prefixes": [
            {"snippet": s, "count": n} for s, n in summary.repeated_prefixes
        ],
        "per_turn_count": len(records),
    }
    return json.dumps(payload, indent=2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="analyze_trajectory",
        description="Summarize prompt/completion/cached tokens and repeated prompt prefixes for a benchmark run dir.",
    )
    parser.add_argument("run_dir", type=Path, help="Path to a benchmark run dir")
    parser.add_argument("--window", type=int, default=200, help="sliding window size in chars (default 200)")
    parser.add_argument(
        "--min-repeats",
        type=int,
        default=2,
        help="report a substring only if it repeats at least N times (default 2)",
    )
    parser.add_argument("--top", type=int, default=20, help="show top N repeated prefixes (default 20)")
    parser.add_argument("--json", action="store_true", help="emit a single JSON object on stdout")
    args = parser.parse_args(argv)

    if not args.run_dir.exists():
        print(f"error: run_dir not found: {args.run_dir}", file=sys.stderr)
        return 2

    summary, records = summarize(
        args.run_dir,
        window=args.window,
        min_repeats=args.min_repeats,
        top=args.top,
    )

    if args.json:
        print(render_json(summary, records))
    else:
        print(render_text(args.run_dir, summary, args.window))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
