#!/usr/bin/env python3
"""analyze.py — #11734 legs 1a/1b analysis.

Joins per-turn client JSONL (turn-driver) with the device logcat
(GENERATE_STREAM from-agent/done lines, release markers) and the exact
prompt-token counts (Qwen3.5 tokenizer — the on-device eliza-1 artifacts are
qwen35-architecture GGUFs), then emits:
  - per-turn table (client TTFT, native window, produced tok, warm/reload)
  - leg 1a: p50/p90 TTFT (all + warm-only)
  - leg 1b: client-side view only; the definitive prefill isolation is
    analyze-prefill.py -> analysis/prefill-fit.json
"""

import json
import gzip
import re
import statistics
import sys
from datetime import datetime

RAW = "/home/shaw/eliza-worktrees/bench-11734/.github/issue-evidence/11734-pixel6a-adb-rows/raw"
YEAR = 2026

def logcat_ts(line):
    m = re.match(r"(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d\d\d)", line)
    if not m:
        return None
    mo, d, h, mi, s, ms = map(int, m.groups())
    return datetime(YEAR, mo, d, h, mi, s, ms * 1000).timestamp()

def load_logcat():
    """Parse start/done (paired by logcat tid), release, and reuse events."""
    events = []
    with _open_logcat() as f:
        for line in f:
            if "ElizaBionicInfer" not in line and "Bench11734" not in line:
                continue
            ts = logcat_ts(line)
            if ts is None:
                continue
            tid_m = re.match(r"[\d\- :.]+\s+\d+\s+(\d+)", line)
            tid = int(tid_m.group(1)) if tid_m else None
            if "GENERATE_STREAM from agent" in line:
                m = re.search(r"(\d+) prompt chars, maxTokens=(\d+)", line)
                events.append(("start", ts, int(m.group(1)), int(m.group(2)), tid))
            elif "GENERATE_STREAM done" in line:
                m = re.search(r"(\d+) tok @ ([\d.]+) tok/s", line)
                events.append(("done", ts, int(m.group(1)), float(m.group(2)), tid))
            elif "releasing resident inference state" in line:
                m = re.search(r"reason=([^,]+),", line)
                events.append(("release", ts, m.group(1) if m else "", None, tid))
            elif "resident prefill reuse" in line:
                m = re.search(r"kept (\d+)/(\d+) prefix tokens, prefilled (\d+)", line)
                events.append(("reuse", ts, tuple(int(x) for x in m.groups()), None, tid))
    return events

def load_runs(name):
    runs = []
    with open(f"{RAW}/{name}") as f:
        for line in f:
            runs.append(json.loads(line))
    return runs

def join(runs, events):
    """Attach the native start/done pair + release classification to each run.

    Fast-path turns are identified by maxTokens=20 (background agent jobs use
    other budgets, e.g. 8192) and each start is paired with the next done on
    the SAME logcat tid, so interleaved background generations cannot
    mis-join.
    """
    out = []
    for r in runs:
        t0 = r["epoch0"] / 1000.0
        t1 = t0 + r["totalMs"] / 1000.0 + 5
        start = next(
            (e for e in events
             if e[0] == "start" and e[3] == 20 and t0 - 2 <= e[1] <= t1),
            None,
        )
        done = None
        if start:
            done = next(
                (e for e in events
                 if e[0] == "done" and e[4] == start[4] and e[1] > start[1]),
                None,
            )
        # a release strictly before this turn's native start (since prior done)
        released_before = None
        if start:
            prior = [e for e in events if e[0] in ("release", "done") and e[1] < start[1]]
            if prior and prior[-1][0] == "release":
                released_before = prior[-1][2]
        reuse = next(
            (e for e in events if e[0] == "reuse" and t0 - 2 <= e[1] <= t1), None,
        )
        out.append({
            **r,
            "promptCharsDevice": start[2] if start else None,
            "nativeWindowMs": round((done[1] - start[1]) * 1000) if start and done else None,
            "producedTok": done[2] if done else None,
            "reportedTokS": done[3] if done else None,
            "reloadTurn": released_before is not None,
            "reuse": reuse[2] if reuse else None,
        })
    return out

def pct(vals, p):
    vals = sorted(vals)
    k = (len(vals) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(vals) - 1)
    return vals[f] + (vals[c] - vals[f]) * (k - f)


def _open_logcat():
    """Open the session logcat, transparently handling the gzipped archive."""
    import os
    plain = f"{RAW}/session-logcat.log"
    if os.path.exists(plain):
        return open(plain, errors="replace")
    return gzip.open(f"{plain}.gz", "rt", errors="replace")

def main():
    events = load_logcat()
    tokens = json.load(open(f"{RAW}/../analysis/prompt-tokens.json"))

    print("=" * 100)
    print("LEG 1a — TTFT distribution (12 identical-length warm turns)")
    print("=" * 100)
    runs = join(load_runs("ttft-runs.jsonl"), events)
    ptoks = tokens["ttftQs"]
    hdr = f"{'label':<10} {'qCh':>4} {'pCh':>4} {'pTok':>5} {'ttftMs':>7} {'nativeMs':>8} {'prod':>5} {'tokS':>6} {'reload':>6}  reply"
    print(hdr)
    for i, r in enumerate(runs):
        pt = ptoks[i]["promptTokens"] if i < len(ptoks) else None
        print(f"{r['label']:<10} {r['qChars']:>4} {r['promptCharsDevice'] or '?':>4} {pt or '?':>5} "
              f"{r['ttftMs']:>7} {r['nativeWindowMs'] or '?':>8} {r['producedTok'] or '?':>5} "
              f"{r['reportedTokS'] or '?':>6} {str(r['reloadTurn']):>6}  {r['text'][:40]}")
    ttfts = [r["ttftMs"] for r in runs if r.get("ttftMs")]
    warm = [r["ttftMs"] for r in runs if r.get("ttftMs") and not r["reloadTurn"]]
    reload_t = [r["ttftMs"] for r in runs if r.get("ttftMs") and r["reloadTurn"]]
    print(f"\nALL   n={len(ttfts)}  p50={pct(ttfts,50):.0f}ms  p90={pct(ttfts,90):.0f}ms  "
          f"min={min(ttfts)}  max={max(ttfts)}  mean={statistics.mean(ttfts):.0f}")
    if warm:
        print(f"WARM  n={len(warm)}  p50={pct(warm,50):.0f}ms  p90={pct(warm,90):.0f}ms  "
              f"min={min(warm)}  max={max(warm)}  mean={statistics.mean(warm):.0f}")
    if reload_t:
        print(f"RELOAD n={len(reload_t)}  p50={pct(reload_t,50):.0f}ms  "
              f"min={min(reload_t)}  max={max(reload_t)}")

    print()
    print("=" * 100)
    print("LEG 1b — client view of the v3 sweep rungs that returned over HTTP")
    print("(definitive prefill isolation is logcat-based: analyze-prefill.py ->")
    print(" analysis/prefill-fit.json; some rungs' HTTP responses hit the client")
    print(" idle timeout while the native work completed — see README)")
    print("=" * 100)
    qtoks = {e["qChars"]: e["promptTokens"] for e in tokens["prefillQs"]}
    pruns = join(load_runs("prefill-runs.jsonl"), events)
    print(hdr)
    for r in pruns:
        pt = qtoks.get(r.get("qChars"))
        print(f"{r['label']:<22} {r.get('qChars', '?'):>4} {r.get('promptCharsDevice') or '?':>4} {pt or '?':>5} "
              f"{r.get('ttftMs') or '?':>7} {r.get('nativeWindowMs') or '?':>8} {r.get('producedTok') or '?':>5} "
              f"{r.get('reportedTokS') or '?':>6} {str(r.get('reloadTurn')):>6}  {r.get('text', '')[:34]}")
    json.dump({"ttft": runs, "prefill": pruns}, open(f"{RAW}/../analysis/joined-runs.json", "w"), indent=1)
    print(f"\njoined-runs.json written")

if __name__ == "__main__":
    main()
