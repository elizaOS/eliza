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
    has_cached: bool = False


@dataclass
class TurnRecord:
    file: str
    index: int
    prompt_text: str
    tokens: TurnTokens


@dataclass
class RunSummary:
    turns: int = 0
    files: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached_tokens: int = 0
    turns_with_cached_field: int = 0
    cache_hit_ratio: float = 0.0
    prompt_chars: int = 0
    repeated_prefixes: list[tuple[str, int]] = field(default_factory=list)


def _coerce_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def extract_tokens(obj: dict[str, Any]) -> TurnTokens | None:
    """Pull a TurnTokens out of one trajectory entry, or None if no signal."""

    # Shape 1: bench-server post-May-2026 — `usage: BenchmarkTurnUsage`.
    usage = obj.get("usage")
    if isinstance(usage, dict):
        prompt = _coerce_int(usage.get("promptTokens") or usage.get("prompt_tokens"))
        completion = _coerce_int(
            usage.get("completionTokens") or usage.get("completion_tokens")
        )
        cached_raw = usage.get("cachedTokens") or usage.get("cached_tokens")
        has_cached = cached_raw is not None
        cached = _coerce_int(cached_raw)
        if prompt or completion or cached:
            return TurnTokens(
                prompt=prompt,
                completion=completion,
                cached=cached,
                has_cached=has_cached,
            )

    # Shape 2: per-call list — `usage.calls[]`.
    if isinstance(usage, dict):
        calls = usage.get("calls")
        if isinstance(calls, list) and calls:
            prompt = sum(_coerce_int(c.get("promptTokens")) for c in calls if isinstance(c, dict))
            completion = sum(
                _coerce_int(c.get("completionTokens")) for c in calls if isinstance(c, dict)
            )
            cached = 0
            has_cached = False
            for c in calls:
                if isinstance(c, dict) and c.get("cachedTokens") is not None:
                    cached += _coerce_int(c.get("cachedTokens"))
                    has_cached = True
            if prompt or completion or cached:
                return TurnTokens(
                    prompt=prompt,
                    completion=completion,
                    cached=cached,
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
                has_cached=has_cached,
            )

    # Shape 4: nested `tokens` dict.
    tokens = obj.get("tokens")
    if isinstance(tokens, dict):
        prompt = _coerce_int(tokens.get("prompt"))
        completion = _coerce_int(tokens.get("completion"))
        cached_raw = tokens.get("cached")
        has_cached = cached_raw is not None
        cached = _coerce_int(cached_raw)
        if prompt or completion or cached:
            return TurnTokens(
                prompt=prompt,
                completion=completion,
                cached=cached,
                has_cached=has_cached,
            )

    return None


def extract_prompt(obj: dict[str, Any]) -> str:
    for key in ("promptText", "prompt_text", "prompt", "user_text", "inputText"):
        v = obj.get(key)
        if isinstance(v, str):
            return v
    return ""


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
        # Common shapes: {"steps":[...]} or {"turns":[...]} or single turn.
        for key in ("steps", "turns", "trajectory", "messages"):
            seq = data.get(key)
            if isinstance(seq, list):
                for item in seq:
                    if isinstance(item, dict):
                        yield item
                return
        yield data


def discover_trajectories(run_dir: Path) -> list[Path]:
    patterns = (
        "**/trajectories.jsonl",
        "**/trajectory*.json",
        "**/trajectory*.jsonl",
        "**/*_traces.jsonl",
        "**/*_trajectory.json",
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
            tokens = extract_tokens(obj) or TurnTokens()
            prompt_text = extract_prompt(obj)
            records.append(
                TurnRecord(
                    file=str(f.relative_to(run_dir)),
                    index=idx,
                    prompt_text=prompt_text,
                    tokens=tokens,
                )
            )
            summary.turns += 1
            summary.prompt_tokens += tokens.prompt
            summary.completion_tokens += tokens.completion
            summary.cached_tokens += tokens.cached
            if tokens.has_cached:
                summary.turns_with_cached_field += 1
            summary.prompt_chars += len(prompt_text)

    if summary.prompt_tokens > 0:
        summary.cache_hit_ratio = summary.cached_tokens / summary.prompt_tokens

    summary.repeated_prefixes = find_repeated_prefixes(
        [r.prompt_text for r in records],
        window=window,
        min_repeats=min_repeats,
        top=top,
    )
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
    lines.append(f"  prompt chars     : {summary.prompt_chars}")
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
        "turns_with_cached_field": summary.turns_with_cached_field,
        "cache_hit_ratio": summary.cache_hit_ratio,
        "prompt_chars": summary.prompt_chars,
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
