"""Shared async Groq driver for the inner-thought synthesis rounds.

The three `synthesize_reasoning_*` scripts share an async Groq pipeline:

  1. Build a queue of `{key, source, task_type, currentMessage, response_text}` items.
  2. For each item POST to Groq's chat/completions with a fixed system prompt,
     retry with backoff on 429/5xx, and apply a cleanliness filter to the
     returned text.
  3. Append accepted thoughts to `data/synthesized/manual_reasoning/thoughts.jsonl`.

This module owns the pipeline. Each round configures it through `RoundConfig`:

  - `system_prompt` and `bad_patterns` per-round prompt + filter
  - `trivial_thoughts` so round-3 can reject the 9 placeholder strings
  - `round_tag` written into each output JSONL row (1, 2 or 3)
  - `keep_dirty` whether to also persist non-clean attempts (round-2/3 yes,
     round-1 no)
  - `synth_payload` controls per-round backoff/temperature/timeouts/headers

Rounds 2 and 3 also need to recognize the "still_dirty" entries written by
prior runs as not-yet-done; that policy is implemented here in
`load_already_done` so the scripts don't reimplement it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, TypedDict

import httpx

API_URL = "https://api.groq.com/openai/v1/chat/completions"
MODEL = "openai/gpt-oss-120b"

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_FILE = ROOT / "data" / "synthesized" / "manual_reasoning" / "thoughts.jsonl"

log = logging.getLogger("groq_thoughts")


class WorkItem(TypedDict):
    """Input row queued for synthesis."""

    key: str
    source: str
    task_type: str
    currentMessage: str
    response_text: str


@dataclass(frozen=True)
class HTTPPolicy:
    """HTTP retry/backoff knobs that vary per round."""

    max_retries: int = 6
    initial_backoff: float = 1.0
    backoff_factor: float = 2.0
    backoff_cap: float = 30.0
    timeout_s: float = 60.0
    initial_temperature: float = 0.6
    temperature_step: float = 0.1
    temperature_floor: float | None = None  # None = step UP toward 0.9
    temperature_cap: float = 0.9
    max_tokens: int = 250
    extra_headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RoundConfig:
    """Per-round configuration."""

    system_prompt: str
    bad_patterns: tuple[str, ...]
    round_tag: int
    trivial_thoughts: frozenset[str] = frozenset()
    keep_dirty: bool = False
    http: HTTPPolicy = field(default_factory=HTTPPolicy)
    out_file: Path = DEFAULT_OUT_FILE


def _bad_re(patterns: Iterable[str]) -> re.Pattern[str]:
    return re.compile("|".join(patterns), re.IGNORECASE)


def make_is_clean(cfg: RoundConfig) -> "callable[[str], bool]":
    """Return the round's cleanliness predicate.

    A clean thought is non-empty, between 5 words and 500 characters,
    matches none of the round's bad patterns, and is not one of the
    trivial-placeholder strings.
    """
    bad_re = _bad_re(cfg.bad_patterns)
    trivial = cfg.trivial_thoughts

    def is_clean(t: str) -> bool:
        if not t:
            return False
        s = t.strip()
        if len(s.split()) < 5 or len(s) > 500:
            return False
        if bad_re.search(s):
            return False
        if s in trivial:
            return False
        return True

    return is_clean


def truncate(text: str, n: int) -> str:
    if len(text) <= n:
        return text
    return text[: n - 3] + "..."


def _adjust_temperature(current: float, http: HTTPPolicy) -> float:
    if http.temperature_floor is None:
        return min(http.temperature_cap, current + http.temperature_step)
    return max(http.temperature_floor, current - http.temperature_step)


async def synth_one(
    *,
    client: httpx.AsyncClient,
    api_key: str,
    user_msg: str,
    response_text: str,
    sem: asyncio.Semaphore,
    cfg: RoundConfig,
    is_clean: "callable[[str], bool]",
) -> str | None:
    """Synthesize one inner thought via Groq, with retries.

    Returns the cleaned thought, or — if all retries failed cleanliness —
    the last non-empty model output (caller decides whether to keep it).
    Returns None when the model produced nothing usable at all.
    """
    user_text = (
        f"User said:\n{user_msg}\n\nMy response:\n{response_text}\n\n"
        "Write my inner thought (first person, 1 sentence, no meta words):"
    )
    payload: dict[str, object] = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": cfg.system_prompt},
            {"role": "user", "content": user_text},
        ],
        "max_tokens": cfg.http.max_tokens,
        "temperature": cfg.http.initial_temperature,
        "reasoning_effort": "low",
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        **cfg.http.extra_headers,
    }
    backoff = cfg.http.initial_backoff
    last_content: str | None = None
    for attempt in range(cfg.http.max_retries):
        async with sem:
            try:
                r = await client.post(API_URL, json=payload, headers=headers, timeout=cfg.http.timeout_s)
            except (httpx.HTTPError, asyncio.TimeoutError):
                if attempt == cfg.http.max_retries - 1:
                    return last_content
                await asyncio.sleep(backoff)
                backoff = min(backoff * cfg.http.backoff_factor, cfg.http.backoff_cap)
                continue
        if r.status_code == 429:
            try:
                wait = float(r.headers.get("retry-after", backoff))
            except ValueError:
                wait = backoff
            await asyncio.sleep(wait + 1.0)
            backoff = min(backoff * cfg.http.backoff_factor, cfg.http.backoff_cap)
            continue
        if r.status_code in (403, 502, 503, 504) or r.status_code >= 500:
            await asyncio.sleep(backoff)
            backoff = min(backoff * cfg.http.backoff_factor, cfg.http.backoff_cap)
            continue
        if r.status_code != 200:
            await asyncio.sleep(backoff)
            backoff = min(backoff * cfg.http.backoff_factor, cfg.http.backoff_cap)
            continue
        data = r.json()
        try:
            content = data["choices"][0]["message"].get("content", "").strip()
        except (KeyError, IndexError):
            return last_content
        if not content:
            # gpt-oss occasionally puts the answer in `reasoning` when
            # max_tokens was hit.
            try:
                rs = (data["choices"][0]["message"].get("reasoning") or "").strip()
                if rs:
                    last = rs.rsplit(".", 2)
                    content = (last[-2] + ".").strip() if len(last) >= 2 else rs
            except (KeyError, IndexError):
                pass
        last_content = content or last_content
        if content and is_clean(content):
            return content
        payload["temperature"] = _adjust_temperature(float(payload["temperature"]), cfg.http)
    return last_content


def load_already_done(cfg: RoundConfig, *, is_clean: "callable[[str], bool]") -> set[str]:
    """Return the set of keys whose existing thought is acceptable.

    `still_dirty` entries are never accepted as done — they always re-queue.
    Trivial placeholders are also skipped (round-3 specifically targets them).
    """
    seen: set[str] = set()
    if not cfg.out_file.exists():
        return seen
    with cfg.out_file.open() as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("still_dirty"):
                continue
            t = (r.get("thought") or "").strip()
            if not t:
                continue
            if t in cfg.trivial_thoughts:
                continue
            if not is_clean(t):
                continue
            key = r.get("key")
            if key:
                seen.add(key)
    return seen


@dataclass
class _Stats:
    ok: int = 0
    dirty_kept: int = 0
    fail: int = 0
    done: int = 0
    queued: int = 0
    skipped: int = 0


async def _worker(
    *,
    queue: asyncio.Queue,
    out_lock: asyncio.Lock,
    out_handle,
    client: httpx.AsyncClient,
    api_key: str,
    sem: asyncio.Semaphore,
    stats: _Stats,
    max_input_chars: int,
    cfg: RoundConfig,
    is_clean: "callable[[str], bool]",
) -> None:
    while True:
        item: WorkItem | None = await queue.get()
        if item is None:
            queue.task_done()
            return
        try:
            user_msg = truncate(item["currentMessage"], max_input_chars)
            resp = truncate(item["response_text"], max_input_chars // 2)
            thought = await synth_one(
                client=client, api_key=api_key, user_msg=user_msg,
                response_text=resp, sem=sem, cfg=cfg, is_clean=is_clean,
            )
            if thought and is_clean(thought):
                row: dict[str, object] = {
                    "key": item["key"],
                    "source": item["source"],
                    "task_type": item["task_type"],
                    "thought": thought,
                }
                if cfg.round_tag != 1:
                    row["round"] = cfg.round_tag
                async with out_lock:
                    out_handle.write(json.dumps(row, ensure_ascii=False) + "\n")
                    out_handle.flush()
                stats.ok += 1
            elif thought and cfg.keep_dirty:
                async with out_lock:
                    out_handle.write(json.dumps({
                        "key": item["key"],
                        "source": item["source"],
                        "task_type": item["task_type"],
                        "thought": thought,
                        "round": cfg.round_tag,
                        "still_dirty": True,
                    }, ensure_ascii=False) + "\n")
                    out_handle.flush()
                stats.dirty_kept += 1
            else:
                stats.fail += 1
        finally:
            stats.done += 1
            queue.task_done()


async def run_round(
    *,
    cfg: RoundConfig,
    items: Iterable[WorkItem],
    concurrency: int,
    max_input_chars: int,
    progress_label: str,
    progress_every_s: float = 15.0,
) -> dict[str, int]:
    """Run a full synthesis round.

    Iterates `items`, dispatches to the configured number of workers, and
    appends accepted thoughts to `cfg.out_file`. `items` may be a generator
    so the caller can stream from disk.

    Returns a stats snapshot.
    """
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise SystemExit("error: GROQ_API_KEY not set")

    cfg.out_file.parent.mkdir(parents=True, exist_ok=True)
    is_clean = make_is_clean(cfg)

    queue: asyncio.Queue[WorkItem | None] = asyncio.Queue(maxsize=concurrency * 4)
    out_lock = asyncio.Lock()
    sem = asyncio.Semaphore(concurrency)
    stats = _Stats()
    start = time.time()

    out_handle = cfg.out_file.open("a", encoding="utf-8")
    client = httpx.AsyncClient(http2=False, limits=httpx.Limits(
        max_connections=concurrency * 2,
        max_keepalive_connections=concurrency,
    ))

    workers = [
        asyncio.create_task(_worker(
            queue=queue, out_lock=out_lock, out_handle=out_handle,
            client=client, api_key=api_key, sem=sem, stats=stats,
            max_input_chars=max_input_chars, cfg=cfg, is_clean=is_clean,
        ))
        for _ in range(concurrency)
    ]

    async def reporter() -> None:
        while True:
            await asyncio.sleep(progress_every_s)
            elapsed = time.time() - start
            rps = stats.done / max(1.0, elapsed)
            eta = (stats.queued - stats.done) / max(0.01, rps)
            print(
                f"[{progress_label}] queued={stats.queued} done={stats.done} "
                f"ok={stats.ok} dirty_kept={stats.dirty_kept} fail={stats.fail} "
                f"skipped={stats.skipped} rps={rps:.1f} elapsed={elapsed:.0f}s "
                f"eta={eta:.0f}s",
                file=sys.stderr,
            )

    rep = asyncio.create_task(reporter())

    for item in items:
        await queue.put(item)
        stats.queued += 1

    print(f"[{progress_label}] queued {stats.queued} records, draining...", file=sys.stderr)
    for _ in workers:
        await queue.put(None)
    await queue.join()
    await asyncio.gather(*workers)
    rep.cancel()
    await client.aclose()
    out_handle.close()

    elapsed = time.time() - start
    snapshot = {
        "ok": stats.ok, "dirty_kept": stats.dirty_kept, "fail": stats.fail,
        "done": stats.done, "queued": stats.queued, "skipped": stats.skipped,
    }
    print(f"[{progress_label} done] {json.dumps(snapshot)} elapsed={elapsed:.0f}s",
          file=sys.stderr)
    return snapshot


# ─────────────────────────── shared parsers ───────────────────────────

def has_thought(toon: str) -> bool:
    """Return True if a TOON record has a non-empty `thought:` line.

    Accepts both bare (`thought: ...`) and quoted (`"thought": ...`) keys.
    """
    if not toon:
        return False
    for line in toon.splitlines():
        s = line.strip()
        key: str | None = None
        if s.startswith("thought:"):
            key = "thought:"
        elif s.startswith('"thought":'):
            key = '"thought":'
        if key:
            v = s[len(key):].strip()
            if v.startswith('"'):
                v = v[1:]
            return bool(v) and v not in ('""', "''", '"', "'")
    return False


def extract_response_text(toon: str) -> str:
    """Pull human-readable assistant text out of a TOON expectedResponse.

    For reply: `text:`/`thought:` shape — returns the text.
    For tool_call/mcp_tool_call: `tool_calls[N]{name,arguments}` — returns
    a short summary of the calls.
    For agent_trace: usually contains `text:` too.
    """
    if not toon:
        return ""
    text_val = ""
    tool_summary: list[str] = []
    in_tools = False
    for raw in toon.splitlines():
        line = raw.rstrip()
        s = line.strip()
        if s.startswith("text:"):
            text_val = s.split(":", 1)[1].strip().strip('"')
        elif s.startswith("tool_calls["):
            in_tools = True
        elif in_tools and s.startswith("- name:"):
            name = s.split(":", 1)[1].strip().strip('"')
            tool_summary.append(name)
        elif in_tools and s.startswith("arguments:"):
            args = s.split(":", 1)[1].strip()
            if tool_summary and len(args) < 200:
                tool_summary[-1] = tool_summary[-1] + " " + args
    if text_val:
        return text_val
    if tool_summary:
        return "[tool calls] " + "; ".join(tool_summary[:3])
    return toon[:300]
